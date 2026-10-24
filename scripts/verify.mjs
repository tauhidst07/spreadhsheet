// Acceptance, golden-set, error-path, purity and Node-side performance checks.
// Usage: node scripts/verify.mjs   (prints one PASS/FAIL line per check; exit code 1 on any failure)
import { readFileSync, readdirSync } from 'node:fs'
import queries from '../fixtures/ai-eval/queries.json' with { type: 'json' }
import formats from '../fixtures/ai-eval/format-prompts.json' with { type: 'json' }
import { createEngine, DEFAULT_COL_WIDTH } from '../src/engine/core.js'
import { parseCellLabel } from '../src/engine/formula.js'
import { applyNumberFormat, toDate, toNum } from '../src/engine/values.js'
import { buildContext, executeQuery, parseAction, requestAction, validateAction } from '../src/ai/runtime.js'
import { planFormat } from '../src/ai/format.js'
import { createMockProvider } from '../src/ai/mockProvider.js'
import { createHttpProvider } from '../src/ai/provider.js'
import { fillTarget } from '../src/grid/GridView.js'
import { parseTsv } from '../src/fixtures/loadSample.js'

const root = new URL('..', import.meta.url).pathname
const small = parseTsv(readFileSync(`${root}fixtures/sales.tsv`, 'utf8'))
const large = parseTsv(readFileSync(`${root}fixtures/sales-large.tsv`, 'utf8'))
let failures = 0
const results = []

function check(name, fn) {
  try {
    const detail = fn()
    if (detail === true || detail === undefined) results.push(`PASS ${name}`)
    else if (typeof detail === 'string' && detail.startsWith('ok:')) results.push(`PASS ${name} (${detail.slice(3)})`)
    else { failures++; results.push(`FAIL ${name}: ${detail}`) }
  } catch (error) { failures++; results.push(`FAIL ${name}: ${error.stack?.split('\n').slice(0, 3).join(' | ')}`) }
}
async function checkAsync(name, fn) {
  try {
    const detail = await fn()
    if (detail === true || detail === undefined) results.push(`PASS ${name}`)
    else if (typeof detail === 'string' && detail.startsWith('ok:')) results.push(`PASS ${name} (${detail.slice(3)})`)
    else { failures++; results.push(`FAIL ${name}: ${detail}`) }
  } catch (error) { failures++; results.push(`FAIL ${name}: ${error.message}`) }
}
const expectEq = (label, actual, expected) => (JSON.stringify(actual) === JSON.stringify(expected) ? true : `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
const all = (...outcomes) => outcomes.find(o => o !== true) ?? true
const time = fn => { const t = performance.now(); fn(); return performance.now() - t }
const sheet = matrix => { const e = createEngine(); e.loadMatrix(matrix); return e }
const raw = (e, label) => { const p = parseCellLabel(label); return e.getCell(p.r, p.c).raw }
const col = (e, c, from, to) => Array.from({ length: to - from + 1 }, (_, i) => e.getCell(from + i, c).raw)

// ── C1 fill handle ────────────────────────────────────────────

check('C1 A2:A3 -> A6 gives ORD-1003..1005, one undo restores', () => {
  const e = sheet(small)
  e.setRange(3, 0, [['x'], ['y'], ['z']])
  const depth = e.undoDepth()
  e.fillRange({ r1: 1, c1: 0, r2: 2, c2: 0 }, { r1: 1, c1: 0, r2: 5, c2: 0 })
  const filled = col(e, 0, 3, 5)
  e.undo()
  return all(expectEq('fill', filled, ['ORD-1003', 'ORD-1004', 'ORD-1005']), expectEq('undo', col(e, 0, 3, 5), ['x', 'y', 'z']), expectEq('depth', e.undoDepth(), depth))
})

check('C1 K2 =G2*H2 / L2 =$G$2*H2 to row 32, then insert row above 10 -> L33 =$G$2*H33', () => {
  const e = sheet(small)
  e.setCell(1, 10, '=G2*H2'); e.setCell(1, 11, '=$G$2*H2')
  e.fillRange({ r1: 1, c1: 10, r2: 1, c2: 11 }, { r1: 1, c1: 10, r2: 31, c2: 11 })
  const k32 = raw(e, 'K32'), l32 = raw(e, 'L32'), k32v = e.getCell(31, 10).computed
  e.insertRow(9)
  return all(expectEq('K32', k32, '=G32*H32'), expectEq('L32', l32, '=$G$2*H32'), expectEq('K32 value', k32v, 1749.65), expectEq('L33', raw(e, 'L33'), '=$G$2*H33'), expectEq('K33', raw(e, 'K33'), '=G33*H33'))
})

check('C1 B2:B4 mixed date formats filled to B8 keep each seed format', () => {
  const e = sheet(small)
  e.fillRange({ r1: 1, c1: 1, r2: 3, c2: 1 }, { r1: 1, c1: 1, r2: 7, c2: 1 })
  return expectEq('B5:B8', col(e, 1, 4, 7), ['2024-01-11', '2024-01-14', '1/17/2024', '2024-01-20'])
})

check('C1 series: numbers, text+number with padding, dates, weekdays, months, backwards, horizontal', () => {
  const e = createEngine(100, 30)
  const run = (seeds, n, dir = 'down') => {
    e.setRange(10, 0, seeds.map(s => [s]))
    if (dir === 'up') { e.fillRange({ r1: 10, c1: 0, r2: 9 + seeds.length, c2: 0 }, { r1: 10 - n, c1: 0, r2: 9 + seeds.length, c2: 0 }); return col(e, 0, 10 - n, 9) }
    e.fillRange({ r1: 10, c1: 0, r2: 9 + seeds.length, c2: 0 }, { r1: 10, c1: 0, r2: 9 + seeds.length + n, c2: 0 })
    return col(e, 0, 10 + seeds.length, 9 + seeds.length + n)
  }
  const h = createEngine(10, 30)
  h.setRange(0, 0, [['Q1', 'Q2']]); h.fillRange({ r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 0, c2: 4 })
  return all(
    expectEq('1,2', run(['1', '2'], 2), ['3', '4']),
    expectEq('single number copies', run(['7'], 2), ['7', '7']),
    expectEq('Item 1', run(['Item 1'], 2), ['Item 2', 'Item 3']),
    expectEq('Q4', run(['Q4'], 1), ['Q5']),
    expectEq('2024-W01', run(['2024-W01'], 2), ['2024-W02', '2024-W03']),
    expectEq('A009', run(['A009'], 2), ['A010', 'A011']),
    expectEq('ISO by delta', run(['2024-01-15', '2024-01-22'], 2), ['2024-01-29', '2024-02-05']),
    expectEq('US single', run(['1/15/2024'], 2), ['1/16/2024', '1/17/2024']),
    expectEq('Mon', run(['Mon'], 7), ['Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon']),
    expectEq('JAN upper', run(['JAN'], 2), ['FEB', 'MAR']),
    expectEq('march lower', run(['march'], 1), ['april']),
    expectEq('Friday title', run(['Friday'], 2), ['Saturday', 'Sunday']),
    expectEq('fill up', run(['3', '4'], 2, 'up'), ['1', '2']),
    expectEq('horizontal', [2, 3, 4].map(c => h.getCell(0, c).raw), ['Q3', 'Q4', 'Q5']),
  )
})

check('C1 formulas: relative shift, $A$1 / $A1 / A$1 pinned in both directions', () => {
  const e = createEngine(50, 20)
  e.setCell(5, 5, '=$A$1+$A1+A$1+A1')
  e.fillRange({ r1: 5, c1: 5, r2: 5, c2: 5 }, { r1: 5, c1: 5, r2: 7, c2: 5 })
  e.fillRange({ r1: 5, c1: 5, r2: 5, c2: 5 }, { r1: 5, c1: 5, r2: 5, c2: 7 })
  return all(expectEq('down', raw(e, 'F8'), '=$A$1+$A3+A$1+A3'), expectEq('right', raw(e, 'H6'), '=$A$1+$A1+C$1+C1'))
})

check('C1 seed styles inherited; dragging back shrinks (clears) in one undo', () => {
  const e = createEngine(50, 10)
  e.setCell(0, 0, '1'); e.setCell(1, 0, '2'); e.setStyle({ r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true })
  e.fillRange({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 })
  const styled = e.getCellStyle(2, 0).bold && !e.getCellStyle(3, 0).bold && e.getCellStyle(4, 0).bold
  const depth = e.undoDepth()
  e.fillRange({ r1: 0, c1: 0, r2: 4, c2: 0 }, { r1: 0, c1: 0, r2: 2, c2: 0 })
  const shrunk = col(e, 0, 0, 4)
  return all(expectEq('styles', styled, true), expectEq('shrink', shrunk, ['1', '2', '3', '', '']), expectEq('one entry', e.undoDepth(), depth + 1))
})

check('C1 Delete clears a selection in one undo; formatting applies to the whole selection', () => {
  const e = sheet(small), depth = e.undoDepth()
  e.clearRange({ r1: 1, c1: 0, r2: 5, c2: 9 })
  const cleared = e.getCell(3, 4).raw === '' && e.undoDepth() === depth + 1
  e.undo()
  e.setStyle({ r1: 1, c1: 1, r2: 3, c2: 2 }, { italic: true })
  return all(expectEq('cleared', cleared, true), expectEq('restored', raw(e, 'E4'), 'Monitor 27"'), expectEq('styled', [e.getCellStyle(1, 1).italic, e.getCellStyle(3, 2).italic, !!e.getCellStyle(4, 2).italic], [true, true, false]))
})

check('C1 budget: 5,000-cell fill < 200 ms', () => {
  const e = createEngine(10000, 20)
  e.setCell(0, 0, 'Item 1'); e.setCell(0, 1, '=A1&"!"')
  const ms = time(() => e.fillRange({ r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 2499, c2: 1 }))
  return ms < 200 && e.getCell(2499, 1).computed === 'Item 2500!' ? `ok:${ms.toFixed(1)} ms` : `${ms.toFixed(1)} ms, value ${e.getCell(2499, 1).computed}`
})

// ── C2 sort and filter ────────────────────────────────────────

check('C2 K=J/G filled, sort Total desc: K2=1080 (ORD-1025), A33 Total, blanks last, SUM range unchanged', () => {
  const e = sheet(small)
  e.setCell(1, 10, '=J2/G2'); e.fillRange({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 31, c2: 10 })
  e.setCell(0, 12, '=SUM(J2:J32)'); e.setCell(0, 13, '=A2')
  const sum = e.getCell(0, 12).computed
  e.sortRange(e.getUsedRange(), 9, 'desc')
  const lastTwo = [e.getText(30, 9), e.getText(31, 9)]
  return all(expectEq('K2', e.getCell(1, 10).computed, 1080), expectEq('A2', raw(e, 'A2'), 'ORD-1025'), expectEq('A33', raw(e, 'A33'), 'Total'),
    expectEq('blank totals last', lastTwo, ['', '']), expectEq('blank row in last block', [raw(e, 'A31'), raw(e, 'A32')].includes(''), true),
    expectEq('SUM text', raw(e, 'M1'), '=SUM(J2:J32)'), expectEq('SUM value', e.getCell(0, 12).computed, sum),
    expectEq('ref follows moved row', e.getCell(0, 13).computed, 'ORD-1001'), expectEq('K formula follows', raw(e, 'K2'), '=J2/G2'))
})

check('C2 filter Region=West (West/West /west) then sort by Units moves only visible rows; undo twice restores order and filter', () => {
  const e = sheet(small)
  const before = col(e, 0, 1, 32)
  e.setFilter(2, { values: ['west'] })
  const hidden = e.hiddenRows(), visible = [...Array(32)].map((_, i) => i + 1).filter(r => !hidden.has(r))
  const visibleRegions = [...new Set(visible.map(r => e.getText(r, 2)))].sort()
  e.sortRange(e.getUsedRange(), 6, 'asc')
  const hiddenStill = [...hidden].every(r => e.getCell(r, 0).raw === before[r - 1])
  const units = visible.filter(r => r < 32).map(r => Number(e.getText(r, 6)))
  e.undo(); e.undo()
  return all(expectEq('visible regions', visibleRegions, ['West', 'West ', 'west']), expectEq('status', `${32 - hidden.size} of 32`, '8 of 32'),
    expectEq('hidden rows unmoved', hiddenStill, true), expectEq('visible sorted', units.every((u, i) => !i || u >= units[i - 1]), true),
    expectEq('order restored', col(e, 0, 1, 32), before), expectEq('filter cleared', e.getFilters().size, 0))
})

check('C2 asc -> desc -> original via stable row identity; styles move with rows; comparison order', () => {
  const e = createEngine(20, 5)
  e.setRange(0, 0, [['V'], ['b'], ['10'], [''], ['A'], ['2'], ['2024-01-05'], ['a']])
  e.setStyle({ r1: 2, c1: 0, r2: 2, c2: 0 }, { bold: true })
  const range = { r1: 0, c1: 0, r2: 7, c2: 0 }
  e.sortRange(range, 0, 'asc', { pinTotals: false })
  const asc = col(e, 0, 1, 7), boldAt = [...Array(7)].map((_, i) => i + 1).find(r => e.getCellStyle(r, 0).bold)
  e.sortRange(range, 0, 'desc', { pinTotals: false })
  const desc = col(e, 0, 1, 7)
  e.sortRange(range, 0, 'original', { pinTotals: false })
  return all(expectEq('asc', asc, ['2', '10', '2024-01-05', 'A', 'a', 'b', '']), expectEq('style moved', e.getCell(boldAt, 0).raw, '10'),
    expectEq('desc', desc, ['b', 'A', 'a', '2024-01-05', '10', '2', '']), expectEq('original', col(e, 0, 1, 7), ['b', '10', '', 'A', '2', '2024-01-05', 'a']))
})

check('C2 sort by Date on sales-large.tsv', () => {
  const e = sheet(large)
  const ms = time(() => e.sortRange(e.getUsedRange(), 1, 'asc'))
  const last = e.getUsedRange().r2
  const days = [...Array(last - 1)].map((_, i) => toDate(e.getText(i + 1, 1))).filter(Boolean)
  return days.every((d, i) => !i || d >= days[i - 1]) && raw(e, `A${last + 1}`) === 'Total' ? `ok:${ms.toFixed(1)} ms for ${last - 1} rows` : 'dates not ascending or totals moved'
})

check('C2 budget: 10,000-row sort < 300 ms, one undo step', () => {
  const rows = [['ID', 'Value', 'Name']]
  for (let i = 0; i < 10000; i++) rows.push([`R${i}`, String((i * 7919) % 10007), `name ${(i * 31) % 997}`])
  const e = sheet(rows), depth = e.undoDepth()
  const ms = time(() => e.sortRange(e.getUsedRange(), 1, 'desc'))
  return ms < 300 && e.undoDepth() === depth + 1 ? `ok:${ms.toFixed(1)} ms` : `${ms.toFixed(1)} ms`
})

// ── C3 virtual grid / engine at scale ─────────────────────────



check('C3 freeze row 1, D = 300 px, insert column before D: new D default width, old D keeps 300', () => {
  const e = sheet(small)
  e.setFrozen(1); e.setColumnWidth(3, 300); e.insertColumn(3)
  return all(expectEq('frozen', e.frozenRows, 1), expectEq('new D', e.getColumnWidth(3), DEFAULT_COL_WIDTH), expectEq('old D', e.getColumnWidth(4), 300), expectEq('data moved', raw(e, 'E1'), 'Sales Rep'))
})

check('C3 row heights move on insert/delete; styles shift with structure and undo', () => {
  const e = sheet(small)
  e.setRowHeight(5, 40); e.setStyle({ r1: 5, c1: 2, r2: 5, c2: 2 }, { bold: true })
  e.insertRow(2)
  const moved = e.getRowHeight(6) === 40 && e.getCellStyle(6, 2).bold
  e.deleteColumn(1)
  const shifted = e.getCellStyle(6, 1).bold
  e.undo(); e.undo()
  return all(expectEq('insert row', moved, true), expectEq('delete col', !!shifted, true), expectEq('undo', [e.getRowHeight(5), !!e.getCellStyle(5, 2).bold], [40, true]))
})

check('C3 delete row referenced by formulas gives #REF!, one undo restores exactly', () => {
  const e = createEngine(20, 5)
  e.setRange(0, 0, [['1'], ['2'], ['3'], ['=A2*10'], ['=SUM(A1:A3)']])
  e.deleteRow(1)
  const after = [raw(e, 'A3'), e.getCell(2, 0).error, raw(e, 'A4'), e.getCell(3, 0).computed]
  e.undo()
  return all(expectEq('after delete', after, ['=#REF!*10', '#REF!', '=SUM(A1:A2)', 4]), expectEq('undo', [raw(e, 'A4'), e.getCell(3, 0).computed, raw(e, 'A5'), e.getCell(4, 0).computed], ['=A2*10', 20, '=SUM(A1:A3)', 6]))
})

check('C3 cycles report #CYCLE! and recover; ranges track every cell', () => {
  const e = createEngine(10, 5)
  e.setCell(0, 0, '=B1'); e.setCell(0, 1, '=A1')
  const cyc = e.getCell(0, 1).error
  e.setCell(0, 1, '5')
  e.setRange(2, 0, [['1'], ['2'], ['3'], ['=SUM(A3:A5)']])
  e.setCell(3, 0, '20')
  return all(expectEq('cycle', cyc, '#CYCLE!'), expectEq('recovered', e.getCell(0, 0).computed, 5), expectEq('range middle edit', e.getCell(5, 0).computed, 24))
})

check('C3 fill-handle target follows the dominant drag axis and shrinks inside the source', () => {
  const s = { r1: 1, c1: 1, r2: 2, c2: 1 }
  return all(expectEq('down', fillTarget(s, 6, 2), { r1: 1, c1: 1, r2: 6, c2: 1 }), expectEq('right', fillTarget(s, 2, 5), { r1: 1, c1: 1, r2: 2, c2: 5 }),
    expectEq('up', fillTarget(s, 0, 1), { r1: 0, c1: 1, r2: 2, c2: 1 }), expectEq('shrink', fillTarget(s, 1, 1), { r1: 1, c1: 1, r2: 1, c2: 1 }))
})

check('C3 undo history is capped at 100 entries', () => {
  const e = createEngine(200, 2)
  for (let i = 0; i < 150; i++) e.setCell(i, 0, String(i))
  return expectEq('depth', e.undoDepth(), 100)
})

// ── C4 ask your data ──────────────────────────────────────────

const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 0.01 : a === b)
const sameRow = (a, b) => a.length === b.length && a.every((v, i) => near(v, b[i]))
function compareResult(actual, expected, sorted) {
  if (expected.error) return actual.error === expected.error && (!expected.detail || actual.detail === expected.detail) ? true : `expected ${expected.error}, got ${JSON.stringify(actual).slice(0, 120)}`
  if (actual.error) return `unexpected ${actual.error} ${actual.detail}`
  if (JSON.stringify(actual.columns) !== JSON.stringify(expected.columns)) return `columns ${JSON.stringify(actual.columns)}`
  if (actual.rowCount !== expected.rowCount || actual.truncated !== expected.truncated) return `rowCount ${actual.rowCount}/${actual.truncated}`
  const rows = expected.rows ?? expected.rowsPreview, got = expected.rows ? actual.rows : actual.rows.slice(0, rows.length)
  if (sorted || expected.rowsPreview) return rows.every((r, i) => sameRow(got[i], r)) ? true : `rows differ at ${rows.findIndex((r, i) => !sameRow(got[i], r))}`
  const pool = [...got]
  for (const r of rows) { const i = pool.findIndex(p => sameRow(p, r)); if (i < 0) return `missing row ${JSON.stringify(r)}`; pool.splice(i, 1) }
  return true
}

const largeMatrix = sheet(large).getRangeText(sheet(large).getUsedRange())
const mock = createMockProvider()
for (const test of queries.cases) {
  await checkAsync(`C4 golden ${test.id} "${test.prompt}"`, async () => {
    const response = await requestAction(mock, test.prompt, buildContext(largeMatrix, 'A1'))
    if (response.error) return compareResult(response, test.expect, false)
    const plan = expectEq('plan', response.action, test.plan)
    if (plan !== true) return plan
    let result
    const ms = time(() => { result = executeQuery(largeMatrix, response.action) })
    const outcome = compareResult(result, test.expect, !!test.plan.sort?.length)
    if (outcome !== true) return outcome
    return ms < 50 ? `ok:${ms.toFixed(1)} ms` : `${ms.toFixed(1)} ms over the 50 ms budget`
  })
}


check('C4 parser: plain, fenced, prose-wrapped JSON; invalid JSON and missing JSON are INVALID_RESPONSE', () => all(
  expectEq('plain', parseAction('{"type":"clarify","question":"x"}').action?.type, 'clarify'),
  expectEq('fenced', parseAction('```json\n{"type":"query"}\n```').action?.type, 'query'),
  expectEq('prose', parseAction('Here is the plan:\n{"type":"query","filters":[{"column":"A","op":"eq","value":"{x}"}]}\nThanks!').action?.filters?.[0]?.value, '{x}'),
  expectEq('invalid', parseAction('{"type": "query",, }').error, 'INVALID_RESPONSE'),
  expectEq('none', parseAction('I cannot help').error, 'INVALID_RESPONSE'),
))

check('C4 validator: schema failures say what failed; non-query/format/clarify types are READ_ONLY', () => all(
  expectEq('bad op', validateAction({ type: 'query', filters: [{ column: 'Region', op: 'like' }] }).detail, 'action.filters[0].op must be one of eq, neq, gt, gte, lt, lte, contains, startsWith, endsWith, isEmpty, notEmpty'),
  expectEq('extra field', validateAction({ type: 'query', drop: true }).detail, 'action.drop is not allowed'),
  expectEq('limit 0', validateAction({ type: 'query', limit: 0 }).error, 'INVALID_RESPONSE'),
  expectEq('bad colour', validateAction({ type: 'format_sheet', headerStyle: { bg: 'blue' } }).error, 'INVALID_RESPONSE'),
  expectEq('clarify needs question', validateAction({ type: 'clarify' }).detail, 'action.question is required'),
  expectEq('mutation', validateAction({ type: 'mutation', action: 'deleteRows' }).error, 'READ_ONLY'),
))

check('C4 executor guardrails: limit 9999 -> 500, unknown column -> UNKNOWN_COLUMN, unknown sort column', () => {
  const r = executeQuery(largeMatrix, { type: 'query', limit: 9999 })
  return all(expectEq('limit', [r.rowCount, r.truncated], [500, true]),
    expectEq('unknown', executeQuery(largeMatrix, { type: 'query', groupBy: ['Territory'], aggregates: [{ fn: 'sum', column: 'Total' }] }), { error: 'UNKNOWN_COLUMN', detail: 'UNKNOWN_COLUMN:Territory' }),
    expectEq('sort', executeQuery(largeMatrix, { type: 'query', sort: [{ column: 'Nope' }] }).error, 'UNKNOWN_SORT_COLUMN'),
    expectEq('read only', executeQuery(largeMatrix, { type: 'mutation' }).error, 'READ_ONLY'))
})

check('C4 coercion: $1,200.00, 10%, 0.1, $ 49.99, N/A; three date formats', () => all(
  expectEq('nums', ['$1,200.00', '10%', '0.1', '$ 49.99', 'N/A', 'n/a', ''].map(toNum), [1200, 0.1, 0.1, 49.99, null, null, null]),
  expectEq('dates', ['2024-1-5', '1/15/2024', '15 Jan 2024', '3 September 2024', '2024-02-30'].map(toDate), ['2024-01-05', '2024-01-15', '2024-01-15', '2024-09-03', null]),
))

check('C4 context: headers, inferred types, 5 sample rows, row count, selection; never the full data', () => {
  const ctx = buildContext(largeMatrix, 'C2:C10')
  return all(expectEq('types', ctx.columns.map(c => c.type), ['id', 'date', 'text', 'text', 'text', 'text', 'number', 'currency', 'percent', 'currency']),
    expectEq('shape', [ctx.sampleRows.length, ctx.rowCount, ctx.selection, ctx.hasTotalsRow, ctx.range], [5, largeMatrix.slice(1, -1).filter(r => r.some(v => v.trim())).length, 'C2:C10', true, 'A1:J2992']),
    expectEq('small payload', JSON.stringify(ctx).length < 4000, true))
})

const fakeFetch = responses => { const calls = []; return { calls, fetch: async (url, init) => { calls.push(JSON.parse(init.body)); const r = responses.shift(); if (r instanceof Error) throw r; return new Response(r.body ?? '', { status: r.status, headers: r.headers ?? {} }) } } }
const ok = text => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: text } }] }) })
const providerCode = async responses => { try { await createHttpProvider({ fetch: fakeFetch(responses).fetch }).complete({ system: 's', user: 'u' }); return 'no error' } catch (e) { return `${e.code}${e.retryAfter ? `:${e.retryAfter}` : ''}` } }

await checkAsync('C4 http provider: 401/403 auth, 429 retry-after, network, 5xx surfaced with codes', async () => all(
  expectEq('401', await providerCode([{ status: 401 }]), 'AUTH_ERROR'),
  expectEq('403', await providerCode([{ status: 403 }]), 'AUTH_ERROR'),
  expectEq('429', await providerCode([{ status: 429, headers: { 'retry-after': '20' } }]), 'RATE_LIMIT:20'),
  expectEq('network', await providerCode([new TypeError('fetch failed')]), 'NETWORK_ERROR'),
  expectEq('500', await providerCode([{ status: 503, body: 'down' }]), 'PROVIDER_ERROR'),
))

await checkAsync('C4 http provider retries once without response_format when the endpoint rejects it', async () => {
  const fake = fakeFetch([{ status: 400, body: 'response_format not supported' }, ok('```json\n{"type":"clarify","question":"Which column?"}\n```')])
  const res = await requestAction(createHttpProvider({ fetch: fake.fetch }), 'anything', buildContext(largeMatrix, null))
  return all(expectEq('calls', fake.calls.map(c => 'response_format' in c), [true, false]), expectEq('action', res.action, { type: 'clarify', question: 'Which column?' }))
})

await checkAsync('C4 provider errors and schema failures reach the caller and change nothing', async () => {
  const e = sheet(small), before = e.version
  const auth = await requestAction(createHttpProvider({ fetch: fakeFetch([{ status: 401 }]).fetch }), 'x', buildContext(small, null))
  const bad = await requestAction({ complete: async () => ({ text: '{"type":"query","limit":"ten"}' }) }, 'x', buildContext(small, null))
  return all(expectEq('auth', auth.error, 'AUTH_ERROR'), expectEq('schema', [bad.error, bad.detail], ['INVALID_RESPONSE', 'action.limit must be integer']), expectEq('sheet untouched', e.version, before))
})

check('C4 insert into sheet writes a result as one undo step', () => {
  const e = sheet(small), depth = e.undoDepth()
  const r = executeQuery(e.getRangeText(e.getUsedRange()), { type: 'query', groupBy: ['Region'], aggregates: [{ fn: 'count', column: 'Order ID' }] })
  e.setRange(0, 12, [r.columns, ...r.rows.map(row => row.map(String))])
  const written = raw(e, 'M1')
  e.undo()
  return all(expectEq('written', written, 'Region'), expectEq('one step', e.undoDepth(), depth), expectEq('undone', raw(e, 'M1'), ''))
})

// ── C5 format with AI ─────────────────────────────────────────

const measure = text => text.length * 7
const view = e => ({ matrix: e.getRangeText(e.getUsedRange()), styleAt: (r, c) => e.getCellStyle(r, c), frozenRows: e.frozenRows, measure })
async function applyGolden(e, prompt) {
  const res = await requestAction(mock, prompt, buildContext(view(e).matrix, 'A1'))
  if (res.error) return { code: res.error }
  const planned = planFormat(view(e), res.action)
  if (planned.code !== 'PLAN') return { code: planned.code, action: res.action }
  let code
  const ms = time(() => { code = engineApply(e, planned.plan) })
  return { code, ms, action: res.action }
}
const engineApply = (e, plan) => e.applyStylePlan(plan)
const styleHolds = (style, want) => Object.entries(want).every(([k, v]) => {
  const got = style[k]
  if (v === false) return !got
  if (k === 'bg' && v === 'white') return !got || got === 'white'
  if (k === 'align' && v === 'left') return !got || got === 'left'
  if (k === 'fontSize' && v === 13) return !got || got === 13
  return got === v
})

// The format golden set is a sequence (f04 unfreezes what f01 froze, f06 clears what came before),
// so it runs in order on one sheet, the way a grader types the prompts. One fixture note is off by
// one row: f03 says J22 is the blank Total, but in sales.tsv the blank Total is J23 (J22 is $3,344.00).
const FIXTURE_ROW_NOTES = { 'f03:J22': 'J23' }
const formatState = e => {
  const used = e.getUsedRange(), styles = []
  for (let r = 0; r <= used.r2; r++) for (let c = 0; c <= used.c2; c++) styles.push(JSON.stringify(e.getCellStyle(r, c)))
  return JSON.stringify([styles, e.frozenRows, Array.from({ length: used.c2 + 1 }, (_, c) => e.getColumnWidth(c)), e.getRangeText(used)])
}

async function runFormatGoldens(matrix, label, mapCell, totalsRow, fresh = false) {
  let e = sheet(matrix)
  for (const test of formats.cases) {
    await checkAsync(`C5 golden ${test.id} "${test.prompt}" on ${label}`, async () => {
      if (fresh) e = sheet(matrix)
      if (test.precondition) e.deleteRow(totalsRow)
      const before = formatState(e), depth = e.undoDepth()
      const { code, ms } = await applyGolden(e, test.prompt)
      const problems = []
      for (const x of test.expect) {
        if (x.result && code !== x.result && !(!label.startsWith('sales.tsv') && test.id === 'f08')) problems.push(`result ${code} != ${x.result}`)
        if (x.result && code !== 'APPLIED' && e.undoDepth() !== depth) problems.push('undo entry added on a no-op')
        if (x.cell) {
          const cell = mapCell(FIXTURE_ROW_NOTES[`${test.id}:${x.cell}`] ?? x.cell), p = parseCellLabel(cell)
          if (x.style && !styleHolds(e.getCellStyle(p.r, p.c), x.style)) problems.push(`${cell} style ${JSON.stringify(e.getCellStyle(p.r, p.c))}`)
          if (label.startsWith('sales.tsv') && x.display !== undefined && e.getDisplay(p.r, p.c) !== x.display) problems.push(`${cell} display "${e.getDisplay(p.r, p.c)}"`)
          if (x.raw !== undefined && e.getCell(p.r, p.c).raw !== matrix[p.r][p.c]) problems.push(`${cell} raw changed`)
        }
        if (x.frozenRows !== undefined && e.frozenRows !== x.frozenRows) problems.push(`frozen ${e.frozenRows}`)
        if (x.undoSteps !== undefined && code === 'NO_CHANGES') {
          // AI_CONTRACT.md §4.7: a no-op (e.g. f03 right after f01 set the same formats) adds no undo entry.
          if (e.undoDepth() !== depth) problems.push('no-op added an undo entry')
        } else if (x.undoSteps !== undefined) {
          if (e.undoDepth() !== depth + 1) problems.push(`undo depth +${e.undoDepth() - depth}`)
          const after = formatState(e)
          e.undo()
          if (formatState(e) !== before) problems.push('one undo did not restore the previous state')
          e.redo()
          if (formatState(e) !== after) problems.push('redo did not reapply')
        }
      }
      if (!label.startsWith('sales.tsv') && test.id === 'f08' && code !== 'APPLIED') problems.push(`freezing 50 of 2,992 rows should apply, got ${code}`)
      if (ms !== undefined && ms >= 300) problems.push(`apply ${ms.toFixed(1)} ms over the 300 ms budget`)
      return problems.length ? problems.join('; ') : ms !== undefined ? `ok:${code} in ${ms.toFixed(1)} ms` : `ok:${code}`
    })
  }
}

await runFormatGoldens(small, 'sales.tsv', cell => cell, 32)
await runFormatGoldens(small, 'sales.tsv, each on a fresh load', cell => cell, 32, true)
await runFormatGoldens(large, 'sales-large.tsv (totals row 2,992)', cell => cell.replace(/^([A-Z]+)(33|32)$/, (_, c, r) => `${c}${r === '33' ? 2992 : 2991}`), 2991)

await checkAsync('C5 unfreeze on a sheet with nothing frozen is NO_CHANGES with no undo entry', async () => {
  const e = sheet(small), depth = e.undoDepth(), { code } = await applyGolden(e, 'Unfreeze the header row')
  return all(expectEq('code', code, 'NO_CHANGES'), expectEq('depth', e.undoDepth(), depth))
})

check('C5 display rules table (AI_CONTRACT.md §4)', () => {
  const inputs = ['79', '$1,200.00', '0.1', '10%', 'n/a', '2024-01-15', '1/15/2024', '15 Jan 2024']
  return all(
    expectEq('number', inputs.map(v => applyNumberFormat(v, 'number')), ['79.00', '1,200.00', '0.10', '0.10', 'n/a', '2024-01-15', '1/15/2024', '15 Jan 2024']),
    expectEq('currency', inputs.map(v => applyNumberFormat(v, 'currency')), ['$79.00', '$1,200.00', '$0.10', '$0.10', 'n/a', '2024-01-15', '1/15/2024', '15 Jan 2024']),
    expectEq('percent', inputs.map(v => applyNumberFormat(v, 'percent')), ['7900%', '120000%', '10%', '10%', 'n/a', '2024-01-15', '1/15/2024', '15 Jan 2024']),
    expectEq('date', inputs.map(v => applyNumberFormat(v, 'date')), ['79', '$1,200.00', '0.1', '10%', 'n/a', '2024-01-15', '2024-01-15', '2024-01-15']),
  )
})

check('C5 OUT_OF_RANGE changes nothing; column indexes clamped; header never number-formatted', () => {
  const e = sheet(small), depth = e.undoDepth()
  const out = planFormat(view(e), { type: 'format_sheet', freezeRows: 33, headerStyle: { bold: true } })
  const outDepth = e.undoDepth() - depth
  const plan = planFormat(view(e), { type: 'format_sheet', headerStyle: { numberFormat: 'currency', bold: true }, columns: [{ col: 7, style: { numberFormat: 'currency', align: 'right' } }, { col: 40, style: { bold: true } }] }).plan
  e.applyStylePlan(plan)
  return all(expectEq('out of range', [out.code, outDepth], ['OUT_OF_RANGE', 0]), expectEq('header', [e.getDisplay(0, 7), e.getCellStyle(0, 7).numberFormat, e.getCellStyle(0, 7).align], ['Unit Price', undefined, undefined]),
    expectEq('clamped', plan.styles.every(([, c]) => c < 10), true))
})

// ── Scale checks (last, so their garbage does not skew the small timings above) ──

check('C3 fill K2 =J2*2 to row 100,000 (Ctrl+D path) and edit J95000 recalculates only dependents', () => {
  const e = sheet(large)
  e.setCell(1, 10, '=J2*2')
  const ms = time(() => e.fillRange({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 99999, c2: 10 }))
  const edit = time(() => e.setCell(94999, 9, '42'))
  return raw(e, 'K100000') === '=J100000*2' && e.getCell(94999, 10).computed === 84 && e.lastRecalcCount === 2
    ? `ok:fill ${ms.toFixed(0)} ms, edit ${edit.toFixed(2)} ms, ${e.lastRecalcCount} cells recalculated`
    : `K100000=${raw(e, 'K100000')} K95000=${e.getCell(94999, 10).computed} recalculated=${e.lastRecalcCount}`
})

check('C3 budget: keystroke edit with 50,000 filled cells < 16 ms (engine part)', () => {
  const e = sheet(large)
  e.setCell(1, 10, '=J2*2'); e.fillRange({ r1: 1, c1: 10, r2: 1, c2: 10 }, { r1: 1, c1: 10, r2: 50000, c2: 10 })
  const ms = time(() => e.setCell(94999, 9, '7'))
  return ms < 16 ? `ok:${ms.toFixed(3)} ms` : `${ms.toFixed(2)} ms`
})

check('C4 budget: two-level group-by over 100,000 generated rows < 500 ms', () => {
  const regions = ['North', 'south ', 'East', 'WEST', 'Central'], cats = ['Electronics', 'Furniture', 'Software', 'accessories']
  const m = [['Region', 'Category', 'Total']]
  for (let i = 0; i < 100000; i++) m.push([regions[i % 5], cats[(i * 7) % 4], `$${((i * 37) % 5000).toFixed(2)}`])
  let result
  const ms = time(() => { result = executeQuery(m, { type: 'query', groupBy: ['Region', 'Category'], aggregates: [{ fn: 'sum', column: 'Total' }, { fn: 'count', column: 'Total' }], sort: [{ column: 'Region' }] }) })
  return ms < 500 && result.rowCount === 20 ? `ok:${ms.toFixed(1)} ms` : `${ms.toFixed(1)} ms, ${result.rowCount} groups`
})

// ── Ground rules ──────────────────────────────────────────────

check('Purity: engine, executor and applier import no React and touch no DOM', () => {
  const files = [...readdirSync(`${root}src/engine`).map(f => `src/engine/${f}`), 'src/ai/runtime.js', 'src/ai/format.js', 'src/ai/contract.js']
  const bad = files.filter(f => /from ['"]react|document\.|window\.|localStorage|\.jsx['"]/.test(readFileSync(`${root}${f}`, 'utf8')))
  return bad.length ? `impure: ${bad.join(', ')}` : true
})

check('No vendor spreadsheet/grid/AI runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'))
  return expectEq('dependencies', Object.keys(pkg.dependencies).sort(), ['react', 'react-dom'])
})

for (const line of results) if (line.startsWith('PASS') || line.startsWith('FAIL')) console.log(line)
console.log(failures ? `FAIL ${failures} check(s) failed` : `PASS all ${results.length} checks`)
process.exitCode = failures ? 1 : 0

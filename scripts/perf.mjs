// Measures the CHALLENGE.md performance budgets on the PRODUCTION build.
//
//   npm run build && npm run preview -- --port 4173 &
//   npm run perf                      # headless Chrome
//   npm run perf -- --headful         # visible window (real vsync)
//
// Needs Google Chrome installed (CHROME_PATH overrides the location).
// Each timing is the median of RUNS runs unless stated otherwise.
import os from 'node:os'
import { readFileSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const APP_URL = process.env.PERF_URL ?? 'http://localhost:4173/?perf'
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const RUNS = 5
const headful = process.argv.includes('--headful')
const queries = JSON.parse(readFileSync(new URL('../fixtures/ai-eval/queries.json', import.meta.url)))
const formats = JSON.parse(readFileSync(new URL('../fixtures/ai-eval/format-prompts.json', import.meta.url)))

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] }
const fmt = (n) => `${n.toFixed(1)} ms`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const results = []
const report = (what, value, budget, method) => {
    results.push({ what, value, budget, method })
    console.log(`${what.padEnd(48)} ${value.padEnd(30)} budget ${budget}`)
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: !headful, args: ['--window-size=1440,960'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 900 })
const mod = 'Control'

async function fresh() {
    await page.goto(APP_URL, { waitUntil: 'networkidle0' })
    await page.waitForFunction(() => window.__sheet)
}
async function nameBox(label) {
    await page.click('.name-box', { clickCount: 3 })
    await page.keyboard.type(label)
    await page.keyboard.press('Enter')
}
const status = () => page.$eval('.status-msg', e => e.textContent)
const msIn = (text) => Number(/in ([\d.]+) ms/.exec(text)?.[1])

// ── First paint ──
const fcp = []
for (let i = 0; i < RUNS; i++) {
    const p = await browser.newPage()
    await p.setCacheEnabled(false)
    await p.goto(APP_URL, { waitUntil: 'networkidle0' })
    fcp.push(await p.evaluate(() => performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? NaN))
    await p.close()
}
report('First contentful paint (cold, no cache)', `${fmt(median(fcp))} (max ${fmt(Math.max(...fcp))})`, '< 100 ms', `performance paint entry, ${RUNS} cold loads`)

// ── Engine budgets measured inside the production bundle ──
await fresh()
const engineNumbers = await page.evaluate((RUNS) => {
    const { engine } = window.__sheet
    const now = () => performance.now()
    const fillTimes = [], sortTimes = []
    for (let i = 0; i < RUNS; i++) {
        engine.clearAll()
        engine.setRange(0, 0, [['1'], ['2']])
        let t = now(); engine.fill({ r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 5001, c2: 0 }); fillTimes.push(now() - t)
        const m = [['n', 'label', 'price']]
        for (let r = 0; r < 10000; r++) m.push([String((r * 7919) % 10007), `row ${r}`, `$${(r % 97) * 3}.25`])
        engine.clearAll(); engine.setRange(0, 0, m)
        t = now(); engine.sortBy(0, 'desc'); sortTimes.push(now() - t)
    }
    engine.clearAll()
    return { fillTimes, sortTimes }
}, RUNS)
report('Fill 5,000 cells (series 1,2 → 5002)', `${fmt(median(engineNumbers.fillTimes))} (max ${fmt(Math.max(...engineNumbers.fillTimes))})`, '< 200 ms', 'engine.fill() in the production bundle')
report('Sort 10,000 rows (numbers, desc)', `${fmt(median(engineNumbers.sortTimes))} (max ${fmt(Math.max(...engineNumbers.sortTimes))})`, '< 300 ms', 'engine.sortBy() in the production bundle')

// ── Sort sales-large by Date through the UI ──
await fresh()
await page.click('button[title^="Load fixtures/sales-large.tsv"]')
await page.waitForFunction(() => document.querySelector('.status-msg').textContent.startsWith('Loaded'))
report('Load sales-large.tsv', fmt(msIn(await status())), '—', 'status bar (engine time)')
const dateSorts = []
for (let i = 0; i < 6; i++) {
    await page.hover('.pane-top .ch:nth-child(2)')
    const btn = await page.$$('.pane-top .ch')
    for (const h of btn) {
        if (await h.$eval('.ch-label', e => e.textContent) === 'B') { await (await h.$('.ch-btn')).click(); break }
    }
    await sleep(50)
    const s = await status()
    if (/Sorted/.test(s) && !/original/.test(s)) dateSorts.push(msIn(s))
}
report('Sort sales-large by Date (2,990 rows, UI click)', `${fmt(median(dateSorts))} (${dateSorts.length} runs)`, '< 300 ms', 'header sort button, status bar time')

// ── AI executor and format applier on sales-large ──
const ai = await page.evaluate((plans) => {
    const { engine, ai } = window.__sheet
    const table = ai.readTable(engine)
    const per = plans.map(plan => {
        const ts = []
        for (let i = 0; i < 5; i++) { const t = performance.now(); ai.executeQuery(plan, table); ts.push(performance.now() - t) }
        return ts.sort((a, b) => a - b)[2]
    })
    const t0 = performance.now(); ai.readTable(engine); const readMs = performance.now() - t0
    const regions = ['North', 'South', 'East', 'West ', 'west', 'Central'], cats = ['Electronics', 'Furniture', 'Accessories', 'Software']
    const rows = []
    for (let i = 0; i < 100000; i++) rows.push([`ORD-${i}`, regions[i % 6], cats[Math.floor(i / 6) % 4], `$${(i % 997) * 3}.50`, `${i % 20}%`])
    const big = { columns: ['Order ID', 'Region', 'Category', 'Total', 'Discount'], rows }
    const plan = { type: 'query', groupBy: ['Region', 'Category'], aggregates: [{ fn: 'sum', column: 'Total', as: 'Sales' }, { fn: 'avg', column: 'Discount', as: 'Avg' }], sort: [{ column: 'Region' }, { column: 'Sales', dir: 'desc' }] }
    const bigTimes = []
    for (let i = 0; i < 5; i++) { const t = performance.now(); ai.executeQuery(plan, big); bigTimes.push(performance.now() - t) }
    return { per, readMs, bigTimes }
}, queries.cases.filter(c => c.plan.type === 'query').map(c => c.plan))
report('Golden query plans on sales-large (slowest)', `${fmt(Math.max(...ai.per))} (median ${fmt(median(ai.per))})`, '< 50 ms', `executeQuery(), median of 5 per plan, ${ai.per.length} plans`)
report('Read sheet into a table for the executor', fmt(ai.readMs), '—', 'readTable() over 2,992 × 10')
report('Two-level group-by over 100,000 rows', `${fmt(median(ai.bigTimes))} (max ${fmt(Math.max(...ai.bigTimes))})`, '< 500 ms', 'executeQuery() on generated rows')
const formatTimes = await page.evaluate((action) => {
    const { engine, ai } = window.__sheet
    const ts = []
    for (let i = 0; i < 5; i++) {
        const t = performance.now()
        const plan = ai.planFormat(action, engine, ai.measureText)
        ai.applyFormat(engine, plan)
        ts.push(performance.now() - t)
        engine.undo()
    }
    return ts
}, formats.cases[0].action)
report('Apply "clean table" (f01) to sales-large', `${fmt(median(formatTimes))} (max ${fmt(Math.max(...formatTimes))})`, '< 300 ms', 'planFormat()+applyFormat() incl. canvas auto-fit')

// ── 100,000-row fill, scroll, keystrokes ──
await nameBox('K2'); await page.keyboard.type('=J2*2'); await page.keyboard.press('Enter')
await nameBox('K2:K100000')
await page.keyboard.down(mod); await page.keyboard.press('d'); await page.keyboard.up(mod)
await page.waitForFunction(() => /Filled/.test(document.querySelector('.status-msg').textContent))
report('Fill K2:K100000 with =J2*2 (Ctrl+D)', fmt(msIn(await status())), '—', 'name box K2:K100000 then Ctrl+D; status bar')
const filled = await page.evaluate(() => {
    const { engine } = window.__sheet
    const u = engine.getUsedRange()
    let n = 0
    for (let r = u.r1; r <= u.r2; r++) for (let c = u.c1; c <= u.c2; c++) if (engine.getText(r, c) !== '') n++
    return n
})
report('Filled cells on the sheet', filled.toLocaleString(), '≥ 50,000', 'count of non-empty cells')

await nameBox('J95000')
await sleep(200)
const scroll = await page.evaluate(async () => {
    const body = document.querySelector('.pane-body')
    const frames = []
    let last = performance.now()
    const start = last
    const commits0 = window.__sheet.perfStats.gridCommits
    await new Promise(resolve => {
        const tick = (t) => {
            frames.push(t - last); last = t
            body.scrollTop += 37 // ~2,200 px/s at 60 fps, a brisk wheel scroll
            if (t - start < 3000) requestAnimationFrame(tick); else resolve()
        }
        requestAnimationFrame(tick)
    })
    frames.shift()
    return { frames, commits: window.__sheet.perfStats.gridCommits - commits0 }
})
const fps = 1000 / median(scroll.frames)
const long = scroll.frames.filter(f => f > 1000 / 60 * 1.5).length
report('Scroll near row 95,000 (3 s, 37 px/frame)', `median ${fmt(median(scroll.frames))}, p95 ${fmt(pct(scroll.frames, 0.95))} (${fps.toFixed(0)} fps)`, '60 fps', `${scroll.frames.length} frames, ${long} over 25 ms, ${scroll.commits} grid renders`)

await nameBox('J95000')
await page.evaluate(() => { const s = window.__sheet.perfStats; s.lastKeyMs = null; s.maxKeyMs = 0; s.keyCount = 0 })
const keyLat = []
await page.keyboard.type('1') // opens the editor (one grid render)
await sleep(100)
const commitsBefore = await page.evaluate(() => window.__sheet.perfStats.gridCommits)
for (const ch of '234567890123456789') {
    const ms = await page.evaluate((ch) => new Promise(resolve => {
        const input = document.activeElement
        const t0 = performance.now()
        input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }))
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(input, input.value + ch)
        input.dispatchEvent(new Event('input', { bubbles: true }))
        requestAnimationFrame(() => resolve(performance.now() - t0))
    }), ch)
    keyLat.push(ms)
    await sleep(30)
}
const commitsDuring = (await page.evaluate(() => window.__sheet.perfStats.gridCommits)) - commitsBefore
await page.keyboard.press('Enter')
report('Keystroke → next frame in J95000 (130k cells)', `median ${fmt(median(keyLat))}, max ${fmt(Math.max(...keyLat))}`, '< 16 ms', `${keyLat.length} keys after the editor opened; grid renders during them: ${commitsDuring}`)
await page.waitForFunction(() => /Saved/.test(document.querySelector('.status-msg').textContent))
report('Commit the J95000 edit', fmt(msIn(await status())), '—', 'status bar; invalidates K95000 only, recomputed when painted')

console.log('\nMachine:', os.cpus()[0].model, `${os.cpus().length} cores`, `${Math.round(os.totalmem() / 2 ** 30)} GB`, os.platform(), os.release())
console.log('Browser:', await browser.version(), headful ? '(headful)' : '(headless)')
console.log('\n| Measurement | Result | Budget | Method |\n|---|---|---|---|')
for (const r of results) console.log(`| ${r.what} | ${r.value} | ${r.budget} | ${r.method} |`)
await browser.close()

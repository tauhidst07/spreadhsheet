// Browser measurements on a production build (vite build + vite preview, headless system Chrome).
// Usage: node scripts/measure.mjs   (builds dist-measure/ with VITE_MEASURE=1 for the React commit counter)
import { spawn, spawnSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'

const root = new URL('..', import.meta.url).pathname
const PORT = 4174, URL_ = `http://127.0.0.1:${PORT}`
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome'

const build = spawnSync('npx', ['vite', 'build', '--outDir', 'dist-measure', '--emptyOutDir'], { cwd: root, env: { ...process.env, VITE_MEASURE: '1' }, encoding: 'utf8' })
if (build.status !== 0) { console.error(build.stderr); process.exit(1) }
const preview = spawn('npx', ['vite', 'preview', '--outDir', 'dist-measure', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' })
await waitFor(URL_)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] })
const out = {}
try {
  // ── First paint (fresh page each time, cache disabled, five loads, median) ──
  const paints = [], gridFrames = []
  for (let i = 0; i < 5; i++) {
    const page = await browser.newPage()
    await page.setCacheEnabled(false)
    await page.setViewport({ width: 1440, height: 900 })
    await page.evaluateOnNewDocument(() => {
      new MutationObserver((_, observer) => {
        if (document.querySelector('.cell')) { observer.disconnect(); requestAnimationFrame(() => { window.__gridFrame = performance.now() }) }
      }).observe(document, { childList: true, subtree: true })
    })
    await page.goto(URL_, { waitUntil: 'load' })
    await page.waitForFunction(() => window.__gridFrame)
    const t = await page.evaluate(() => ({ fcp: performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint')?.startTime ?? null, grid: window.__gridFrame }))
    paints.push(t.fcp); gridFrames.push(t.grid)
    await page.close()
  }
  out.firstContentfulPaintMs = { median: median(paints), runs: paints.map(round) }
  out.firstGridFrameMs = { median: median(gridFrames), runs: gridFrames.map(round), note: 'time until the virtual grid has rendered its first frame of cells' }

  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.evaluateOnNewDocument(() => {
    window.__longTasks = []
    new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longTasks.push(e.duration) }).observe({ type: 'longtask', buffered: true })
  })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()) })
  await page.goto(URL_, { waitUntil: 'networkidle0' })

  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))))
  const idle = async () => { await page.waitForFunction(() => !document.querySelector('.busy'), { timeout: 60000 }); await settle() }
  const phase = async (name, fn) => {
    await page.evaluate(() => { window.__longTasks.length = 0 })
    const t = Date.now()
    try { await fn(); await idle() } catch (error) {
      out[name] = { error: error.message.split('\n')[0] }
      if (process.env.MEASURE_DEBUG) await page.screenshot({ path: `${process.env.MEASURE_DEBUG}/${name}.png` })
      return
    }
    const tasks = await page.evaluate(() => window.__longTasks.slice())
    out[name] = { wallMs: Date.now() - t, longTasks: tasks.length, maxLongTaskMs: round(Math.max(0, ...tasks)) }
  }
  const nameBox = async text => { await page.click('.name-box'); await page.keyboard.type(text); await page.keyboard.press('Enter'); await settle() }
  const ctrl = async key => { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control') }

  await page.click('button[title^="Load fixtures/sales-large.tsv"]')
  await idle()

  // ── Fill K2:K50001 with =J2*2 (Ctrl+D through the name box) ──
  await nameBox('K2'); await page.keyboard.type('=J2*2'); await page.keyboard.press('Enter'); await settle()
  await phase('fillK2toK50001', async () => { await nameBox('K2:K50001'); await ctrl('d') })

  // ── Scroll at row 95,000 ──
  await nameBox('A95000'); await settle()
  out.scrollAtRow95000 = await page.evaluate(async () => {
    const scroller = document.querySelector('.grid-scroller')
    window.__longTasks.length = 0
    const frames = []
    let last = performance.now()
    for (let i = 0; i < 120; i++) {
      scroller.scrollTop += i < 60 ? 96 : -96
      await new Promise(r => requestAnimationFrame(r))
      const now = performance.now(); frames.push(now - last); last = now
    }
    frames.shift()
    const sorted = [...frames].sort((a, b) => a - b)
    return { frames: frames.length, avgFrameMs: frames.reduce((a, b) => a + b, 0) / frames.length, p95FrameMs: sorted[Math.floor(sorted.length * 0.95)], maxFrameMs: sorted.at(-1), framesOver20ms: frames.filter(f => f > 20).length, longTasks: window.__longTasks.length }
  })

  // ── Type into J95000 (after 50k fills): keystroke → next frame, and React commits ──
  await nameBox('J95000')
  await page.evaluate(() => {
    window.__keyLatency = []
    window.__commitsBefore = window.__reactCommitCount
    window.addEventListener('keydown', e => {
      const t0 = e.timeStamp
      requestAnimationFrame(() => setTimeout(() => window.__keyLatency.push({ key: e.key, ms: performance.now() - t0 }), 0))
    }, { capture: true })
  })
  for (const key of ['4', '2']) { await page.keyboard.press(key); await settle() }
  const typingCommits = await page.evaluate(() => window.__reactCommitCount - window.__commitsBefore)
  await page.keyboard.press('Enter'); await settle()
  const typing = await page.evaluate(() => ({ latency: window.__keyLatency, commits: window.__reactCommitCount - window.__commitsBefore, k: document.querySelector('.formula-bar-input').value }))
  out.typeJ95000 = { keystrokeToNextFrameMs: typing.latency.map(l => `${l.key}:${round(l.ms)}`), reactCommitsWhileTyping: typingCommits, reactCommitsIncludingEnter: typing.commits }

  // ── Fill K2:K100000 (acceptance) ──
  await phase('fillK2toK100000', async () => { await nameBox('K2:K100000'); await ctrl('d') })
  out.fillK2toK100000.check = await page.evaluate(() => window.__sheet.engine.getCell(99999, 10).raw)

  const clickSort = async col => {
    const at = await page.evaluate(c => { const v = window.__sheet.view, r = v.host.getBoundingClientRect(); return { x: r.left + 52 + v.colsPos[c + 1] - v.scrollX - 32, y: r.top + 13 } }, col)
    await page.mouse.click(at.x, at.y)
  }
  // ── Sort 10,000 rows (explicit selection A1:K10001, header row 1) ──
  await page.keyboard.press('Escape'); await nameBox('A1'); await settle()
  await nameBox('A1:K10001')
  await phase('sort10000Rows', () => clickSort(6))
  await phase('undoSort10000', () => ctrl('z'))
  // ── Sort the 100,000-row used range by K ──
  await nameBox('A1')
  await phase('sort100000Rows', () => clickSort(10))
  await phase('undoSort100000', () => ctrl('z'))
  await phase('redoSort100000', () => ctrl('y'))
  await phase('undoSort100000Again', () => ctrl('z'))
  // ── Filter Region contains "west" through the dropdown ──
  await phase('filterRegionWest', async () => {
    const at = await page.evaluate(() => { const v = window.__sheet.view, r = v.host.getBoundingClientRect(); return { x: r.left + 52 + v.colsPos[3] - 12, y: r.top + 13 } })
    await page.mouse.click(at.x, at.y)
    await page.waitForSelector('.filter-menu')
    await page.select('#fm-condition', 'contains')
    await page.type('.fm-condition input', 'west')
    await page.click('.fm-actions .primary')
  })
  out.filterRegionWest.status = await page.$eval('.status-filter', n => n.textContent).catch(() => null)
  await phase('undoFilter', () => ctrl('z'))
  await phase('undoFill100000', () => ctrl('z'))
  await phase('redoFill100000', () => ctrl('y'))
  out.consoleErrorsOrWarnings = errors
} finally {
  await browser.close()
  preview.kill()
}
console.log(JSON.stringify(out, null, 2))

function round(n) { return n === null ? null : Math.round(n * 10) / 10 }
function median(list) { const s = [...list].sort((a, b) => a - b); return round(s[Math.floor(s.length / 2)]) }
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return } catch { /* preview still starting */ }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`preview did not start on ${url}`)
}

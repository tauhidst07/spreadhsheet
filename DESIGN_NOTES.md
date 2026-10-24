# Design notes

## Architecture

| Layer | Files | Rule |
|---|---|---|
| Engine (pure) | `src/engine/values.js`, `formula.js`, `fill.js`, `core.js` | No React, no DOM, no browser globals (ESLint `no-restricted-imports` + ES-only globals on these files; `verify.mjs` also greps them) |
| AI logic (pure) | `src/ai/contract.js`, `runtime.js` (parse, validate, context, executor), `format.js` (applier) | Same purity rule |
| Providers | `src/ai/provider.js`, `mockProvider.js`, `server/aiRelay.js` | Only these know about HTTP or vendors |
| Grid view | `src/grid/GridView.js` (imperative), `FilterMenu.jsx` | Owns the cell DOM; React never renders cells |
| Chrome | `src/App.jsx`, `Toolbar.jsx`, `src/ai/AiPanel.jsx` (lazy chunk) | Toolbar, formula bar, name box, status bar, job runner, Ctrl+K panel |

## Data model

- `rowsById: Map<row, RowRec>`, sparse. A `RowRec` is `{ id, cells: Map<col, Cell>, styles: Map<col, Style>, height? }`. Everything that belongs to a row lives in its record, so a sort or a row insert moves one object per row and styles, heights and the stable row id travel with it.
- `Cell` is either a literal `{ raw, num }` (`num` = coerced number or `null`, so `$1,200.00` and `10%` work inside formulas while displaying as typed) or a formula `{ tpl, value }`.
- A formula is stored as a **template**: its text split into literal parts and reference specs, where relative references are offsets from the host cell and `$` references are fixed indices. Moving a template to another cell shifts relative references for free (fill, sort). Identical relative formulas share one interned template and one parsed AST, so `=J2*2` filled down 100,000 rows is one template.
- Dependency graph: single-cell edges `Map<cellKey, formulaKey | Set>` plus range edges bucketed by column (`Map<col, Map<formulaKey, [r1, r2][]>>`). Every cell of a range is tracked (the starter tracked only the end points).
- `colWidths: Map<col, px>`, `filters: Map<col, Filter>`, `frozenRows`, `frozenCols`, undo/redo stacks (max 100 entries).
- Cell keys are numbers (`row * 16384 + col`).

## Engine API (`createEngine(rows = 100000, cols = 200)`)

Reading
- `getCell(r, c) → { raw, computed, error }`: raw text (formula text rebuilt from the template), computed value, error code.
- `getValue(r, c)`: computed value: number, text, `''` or `{ error }`.
- `getText(r, c)`: display text before number formatting (what sorting, filters and queries read).
- `getDisplay(r, c)`: text as the grid shows it, with the cell's `numberFormat` applied.
- `getCellStyle(r, c)`: copy of the cell style.
- `getUsedRange() → { r1, c1, r2, c2 } | null`: bounding box of non-empty cells (maintained incrementally).
- `getRangeText(range) → string[][]`: display text of a rectangle (input to the AI executor and applier).
- `getColumnWidth(c)`, `getRowHeight(r)`, `hasCustomRowHeights()`.
- `isRowHidden(r)`, `hiddenRows() → Set | null`, `getFilter(c)`, `getFilters()`, `distinctValues(c) → [{ key, label, count }]` (first-seen label, `''` = blanks).
- Getters: `rows`, `cols`, `version`, `layoutVersion`, `frozenRows`, `frozenCols`, `lastRecalcCount` (cells visited by the last recalculation), `canUndo()`, `canRedo()`, `undoDepth()`.

Writing (each call is one undo entry, none when nothing changes)
- `setCell(r, c, raw)`: edit one cell; recalculates only its dependents.
- `setRange(r, c, matrix)`: write a block (AI "Insert into sheet").
- `clearRange(range)`: clear values in a rectangle (styles kept).
- `fillRange(source, target)`: fill-handle / Ctrl+D fill; a target inside the source clears the uncovered cells.
- `sortRange(range, col, dir, { header = true, pinTotals = true })`: `dir` is `asc`, `desc` or `original`.
- `setStyle(range, patch)`: merge a style into every cell of a range (whole-column/row selections are clamped to the used range).
- `applyStylePlan({ styles, widths, frozenRows }) → 'APPLIED' | 'NO_CHANGES'`: the AI format applier's output.
- `setColumnWidth(c, px)`, `setRowHeight(r, px)`, `autoFitColumn(c, measure)`, `setFrozen(rows, cols)`.
- `setFilter(c, { values?, op?, value? } | null)`, `clearFilters()`.
- `insertRow(at, count)`, `deleteRow(at, count)`, `insertColumn(at, count)`, `deleteColumn(at, count)`.
- `loadMatrix(matrix)`: replace the sheet (clears history).
- `undo()`, `redo()`.
- Step generators for the UI: `fillRangeSteps`, `clearRangeSteps`, `sortRangeSteps`, `undoSteps`, `redoSteps` produce the same result and the same single undo entry as the synchronous calls, but yield every 5,000 cells/rows so the app can time-slice them.

Module exports: `normalizeStyle`, `DEFAULT_COL_WIDTH` (100), `DEFAULT_ROW_HEIGHT` (24); `values.js`: `toNum`, `toDate`, `parseDate`, `norm`, `applyNumberFormat`, `isTotalsLabelRow`, `looksLikeTotalsRow`; `formula.js`: `compileFormula`, `formulaText`, `remapTemplate`, `evaluate`, `colLabel`, `cellLabel`, `parseCellLabel`, `parseRangeLabel`; `fill.js`: `seriesFor(seeds) → at(k)`.

Formulas: numbers, references, ranges, `+ - * / ^ &`, comparisons, `SUM AVERAGE AVG MIN MAX COUNT ABS ROUND IF`. Errors: `#REF! #VALUE! #DIV/0! #NAME? #PARSE! #CYCLE!`.

## Undo semantics (what one Ctrl+Z reverts)

Entries are patches of old/new pairs (cells, styles, widths, heights, freeze, filters), never full-state snapshots, except where noted.

| Action | One undo reverts | Stored |
|---|---|---|
| Cell edit | that cell | 1 cell pair |
| Fill (handle or Ctrl+D) | every filled/cleared cell and copied style | changed cells + styles |
| Delete / Backspace | every cleared cell in the selection | changed cells |
| Sort (incl. "original") | the whole reorder, with formulas and styles | the row permutation (`from`, `to`) |
| Filter change / clear all | that filter change | filter pair(s) |
| Toolbar formatting, resize, auto-fit, freeze | that change | style/size/freeze pairs |
| Insert row/column | the insert | position + count |
| Delete row/column | the delete, including formulas that became `#REF!` | removed rows/cells/widths + previous templates |
| AI format Apply | all styles, widths and freeze of the action (none when `NO_CHANGES`) | style/width/freeze pairs |
| AI Insert into sheet | the whole written block | changed cells |

## Fill rules

Per column (vertical fill) or per row (horizontal): formulas copy their template (relative references shift, `$A$1`/`$A1`/`A$1` stay pinned); two or more plain numbers continue linearly (one number copies); dates (`YYYY-M-D`, `M/D/YYYY`, `D Mon YYYY`) step by the gap between the last two seeds (1 day for one seed), each new cell in the format of its seed in the cycle; weekday/month names cycle keeping case; text ending in a number increments keeping zero padding; anything else copies cyclically. Seed styles are copied; dragging back inside the source clears the uncovered cells.

## Sort and filter

Data block: a multi-row selection (row 1 is a header only if the selection starts at row 1), otherwise the used range with row 1 as header. A trailing totals row (first filled cell matches `Total`/`Totals`/`Subtotal`/`Sum`) is pinned. Order: numbers and dates (as day numbers) before text, text case-insensitive, blanks last in both directions, stable. Whole rows move. Formula references to moved rows follow them; a reference inside a single row moves with that row; a range spanning several rows is unchanged (`=SUM(J2:J32)` keeps its text and value). With filters active only visible rows are reordered. `original` sorts by the stable row id (load order). Filters compare `trim().toLowerCase()` values, so `West`, `West ` and `west` are one checklist entry; conditions: contains, greater than, less than, is empty; columns combine with AND; hidden rows get height 0 (row numbers show gaps) and still feed formulas.

## Virtual grid

- One transparent native scroller on top receives wheel, mouse and keyboard input; eight clipped layers underneath (body, frozen row band, frozen column band, frozen corner, column headers, frozen column headers, row headers, frozen row headers) are translated once per animation frame.
- Prefix sums (`Float64Array`, hidden rows = 0 px) plus binary search give the visible rows/columns plus overscan (6 rows, 2 columns). Hit-testing is arithmetic on the prefix sums; no handler reads layout.
- Cells are a keyed, pooled set of divs: a cell that stays visible keeps its element; only newly visible cells are written; text and style writes are skipped when unchanged. `contain: strict` on layers and cells, `will-change: transform` on the moving layers.
- Scroll handler only schedules one `requestAnimationFrame`; all reads/writes happen in that frame. Drag selection, fill and resize also update at most once per frame.
- One floating editor (textarea) and the formula bar are uncontrolled inputs mirrored without React state, so typing causes 0 React commits.
- React state is only the selection, a version tick, busy/toast and panel flags.

## Performance: root causes found and fixed

| Symptom | Cause (measured) | Fix |
|---|---|---|
| ~290 ms per edit at J95000 | every `setCell` bumped a global cache generation, so every read recomputed; structural edits rebuilt the whole graph; bulk actions deep-copied the whole sheet into undo | dependency graph with per-cell and per-column range edges, topological recalculation of dependents only (an edit at J95000 visits 2 cells), patch undo |
| Stutter, freezes | React rendered every visible cell as a component and re-created the whole grid on every version tick; a full-sheet `Array.from` matrix was built for AI context | imperative pooled grid, AI reads only the used range |
| 484 ms first paint | parsing/rendering before first frame, stylesheet blocking paint | static HTML shell + inlined CSS paint before scripts run; AI panel (with mock fixtures) and sample data are separate chunks loaded on demand |
| Long tasks on 100k operations | synchronous fill/sort/undo, full re-link on sort, used-range rescans | time-sliced step generators with a progress state, sort re-links only moved rows and their referrers, used range kept incrementally |

## AI

Provider setup
- `createProvider()` returns the mock or the http provider; nothing else knows which. The mode is resolved at build/serve time from `.env.local`: `AI_PROVIDER=http` **and** `AI_API_KEY` set → `http`; otherwise `mock` (the panel shows "Mock provider" or "Live model").
- The http provider posts OpenAI-compatible chat messages with plain `fetch` to the same-origin relay `/api/ai/chat` (`server/aiRelay.js`, mounted in `vite` dev, `vite preview` and `npm run server`). The relay adds `AI_MODEL` and `Authorization: Bearer AI_API_KEY` and forwards to `AI_ENDPOINT`, passing status codes and `Retry-After` through. The key is never in the browser bundle.
- Requests use `temperature: 0` and `response_format: { type: 'json_object' }`; a 400 is retried once without `response_format`. Errors are typed and shown in the panel: 401/403 `AUTH_ERROR`, 429 `RATE_LIMIT` (with retry-after), fetch failure `NETWORK_ERROR`, 5xx/other `PROVIDER_ERROR`.

Request: system prompt (task, the three JSON Schemas from `contract.js`, rules, "answer with a single JSON object"), optional history (last 3 prompt/answer pairs), and a user turn `Sheet context:\n<json>\n\nRequest: <prompt>`. The context is built from the used range only (types inferred from at most 200 rows; never the full data). Exact shape (sales.tsv, `sampleRows` shortened here to 1 of the 5 sent):

```json
{"range":"A1:J33","rowCount":30,"columns":[{"name":"Order ID","index":0,"type":"id","examples":["ORD-1001","ORD-1002","ORD-1003"]},{"name":"Date","index":1,"type":"date","examples":["2024-01-03","2024-01-05","1/8/2024"]},{"name":"Region","index":2,"type":"text","examples":["North","West","East"]},{"name":"Sales Rep","index":3,"type":"text","examples":["Aarav Shah","Priya Nair","Ben Carter"]},{"name":"Product","index":4,"type":"text","examples":["Laptop Pro","Desk Chair","Monitor 27\""]},{"name":"Category","index":5,"type":"text","examples":["Electronics","Furniture","Accessories"]},{"name":"Units","index":6,"type":"number","examples":["4","12","6"]},{"name":"Unit Price","index":7,"type":"currency","examples":["$1,200.00","$189.50","$320.00"]},{"name":"Discount","index":8,"type":"percent","examples":["10%","5%","15%"]},{"name":"Total","index":9,"type":"currency","examples":["$4,320.00","$2,160.30","$1,920.00"]}],"sampleRows":[["ORD-1001","2024-01-03","North","Aarav Shah","Laptop Pro","Electronics","4","$1,200.00","10%","$4,320.00"]],"selection":"C2:C10","hasTotalsRow":true}
```

`rowCount` counts data rows excluding blank rows and the totals row.

Response handling: `parseAction` takes the first balanced JSON object (prose and code fences allowed) → `validateAction` checks it against the contract schemas with a hand-written JSON-Schema subset (`type`, `const`, `enum`, `required`, `additionalProperties`, `items`, `minimum`, `maximum`, `pattern`) and reports the failing path; any other `type` is `READ_ONLY`. Only then does the executor or applier run. Invalid responses change nothing.

Executor (`executeQuery(matrix, plan)`) follows AI_CONTRACT.md §3 over display text: blank rows skipped, totals row excluded unless `excludeTotalsRow: false`, `norm`/`toNum`/`toDate` coercion, AND filters, group keys on normalised values with the first-seen trimmed label, `count countDistinct sum avg min max`, multi-key stable sort (numbers before text), limit clamped to 500 in code, numbers rounded to 2 decimals. Unknown columns return `UNKNOWN_COLUMN`; the panel turns that into a question listing the real columns and runs nothing.

Applier (`planFormat(view, action)`) follows §4: header = row 1, body = row 2 to the last used row, totals style only when the last row looks like a totals row (label regex or summary-line heuristic), order clear → body → columns → totals → header (header never number-formatted), column indexes and widths clamped, `freezeRows ≥ used rows` → `OUT_OF_RANGE` with nothing applied, auto-fit measured with a canvas last. The engine applies the plan as one undo step or reports `NO_CHANGES`.

Panel (Ctrl+K): prompt, history of cards, plain-words plan, row count and timing, "Show plan" JSON toggle (global and per card), Re-run (re-executes the stored plan, no model call), Insert into sheet at a chosen cell (one undo), clarify cards, format preview with Apply / Discard, and error cards that say nothing was changed.

## Measurements

Machine: this Linux workstation, Node 20.20, headless system Chrome (`/usr/bin/google-chrome`, software rendering), 1440×900 viewport.

Node (`node scripts/verify.mjs`, final run; engine and executor only):

| Budget | Measured | Target |
|---|---|---|
| Fill 5,000 cells | 37.4 ms | < 200 ms |
| Sort 10,000 rows | 94.3 ms | < 300 ms |
| Sort sales-large.tsv by Date (2,990 rows) | 38.3 ms | report |
| Fill K2 → K100,000 (`=J2*2`) | 281 ms | (no budget) |
| Engine edit at J95000 with 50,000 filled cells | 0.069 ms, 2 cells recalculated | < 16 ms |
| Slowest golden query plan on sales-large.tsv | 32.5 ms | < 50 ms |
| Two-level group-by, 100,000 generated rows | 197.5 ms | < 500 ms |
| Format apply on sales-large.tsv (slowest golden, f06) | 36.1 ms | < 300 ms |

Browser (`node scripts/measure.mjs`, final single run): production build with `VITE_MEASURE=1` (adds a React `<Profiler>` commit counter and `window.__sheet`; the profiling renderer is aliased only in that build), served by `vite preview`, driven by puppeteer-core. Long tasks come from a `PerformanceObserver('longtask')`.

| Metric | Method | Measured (final run) | Budget | Met |
|---|---|---|---|---|
| First contentful paint | 5 fresh loads, cache off, median (runs 248 / 96 / 128 / 96 / 120) | 120 ms | < 100 ms | No |
| First grid frame (cells rendered) | same loads, median | 242 ms | — | — |
| Scroll at row 95,000 | 119 rAF frames, `scrollTop ± 96 px` per frame | avg 17.6 ms, p95 24 ms, max 36.3 ms, 16 frames > 20 ms, 0 long tasks | 60 fps, no long frames | Partly |
| Keystroke → next frame, typing into J95000 after the 50k fill | keydown `timeStamp` → rAF → task | 17.8 ms, 25.2 ms | < 16 ms | No |
| Enter (commit + recalc + repaint) | same | 19.2 ms | — | — |
| React commits while typing / including Enter | Profiler counter | 0 / 2 | no per-cell state | Yes |
| Fill K2:K50,001 via name box + Ctrl+D | long tasks during the job | max 102 ms (3 long tasks), 618 ms wall | no task > 100 ms | No (by 2 ms) |
| Fill K2:K100,000 | same | max 110 ms, 902 ms wall; K100000 = `=J100000*2` | no task > 100 ms | No |
| Sort 10,000 rows (selection) / undo | same | max 115 ms / 57 ms | no task > 100 ms | No / Yes |
| Sort 100,000 rows / undo / redo / undo | same | max 57 / 100 / 63 / 0 ms | no task > 100 ms | Yes (undo at 100 ms) |
| Filter Region contains "west" / undo | same | max 56 / 0 ms; status "553 of 99,999 rows" | no task > 100 ms | Yes |
| Undo / redo fill of 100,000 | same | 0 / 0 long tasks | no task > 100 ms | Yes |
| Console errors or warnings | page listeners | none | none | Yes |

Run-to-run variance on this machine is large: development runs of the same script earlier on the same day measured FCP medians of 80–132 ms, keystrokes 6–12 ms, Enter 13–17 ms and no long task above 81 ms. The table reports only the final run, unedited.

Why the misses happen and what is next
- First paint: the HTML shell with inlined CSS paints before any script, but under load the median slipped to 120 ms; the interactive grid needs the 257 kB main chunk (React is ~190 kB of it) to evaluate. Next: preload hints, trimming the main chunk, measuring on a GPU-backed (headed) Chrome where raster is not software.
- Keystrokes: the per-key JS is a value assignment (0 React commits); the remaining time is style/paint/raster of the editor and formula bar in software-rendered headless Chrome. Next: profile with a GPU, avoid the textarea's layout on each input.
- Long tasks 100–115 ms: a job slice is checked only at generator yields (every 5,000 cells or rows), and the slice that contains a whole JS `Array.prototype.sort` of 10,000–100,000 rows or the final commit plus React/grid repaint can exceed 100 ms when the machine is busy. Next: smaller step size, a non-blocking merge sort that yields, or moving the engine into a Web Worker.

## Dependencies

Runtime: `react`, `react-dom` only. Dev-only: `vite`, `@vitejs/plugin-react`, `eslint` and plugins, `vitest` (the starter's unit tests, `npm test`), `puppeteer-core` (drives the system Chrome for `scripts/measure.mjs`; no bundled browser, never shipped). No spreadsheet, formula, grid or AI libraries; the AI provider uses plain `fetch`.

## Assumptions

- Clicking a column letter selects the column (C1); sorting is the ⇅ icon in each column header and the Sort buttons in the filter menu, cycling asc → desc → original.
- One seed that is text ending in a number increments (spreadsheet behaviour); one plain number copies.
- Date seeds with uneven gaps step by the last gap; each new cell takes the format of its seed in the cycle (B2:B4 → B8 gives 2024-01-11, 2024-01-14, 1/17/2024, 2024-01-20).
- `$` references keep their markers and still follow their data on insert/delete, as in every spreadsheet; they never shift on fill.
- Sort moves whole rows (all columns, heights, ids) even when the selection is narrower, so records stay intact.
- Filters apply to rows 2 through the last used row, including the totals row; filter changes are undo steps so "undo twice" restores both the order and the unfiltered view.
- "Original" order is the stable row id (load order); rows created later get later ids.
- The format golden set is a sequence (f04 unfreezes what f01 froze, f06 clears what came before); `verify.mjs` runs it in order and also on a fresh load per prompt; a repeated no-op such as f03 after f01 is `NO_CHANGES` with no undo entry (contract §4.7).
- The f03 note "J22 blank" is one row off in the fixture: the blank Total is J23 (J22 is $3,344.00); `verify.mjs` checks J23.
- Environment variables are `AI_PROVIDER`, `AI_ENDPOINT`, `AI_API_KEY`, `AI_MODEL` in `.env.local`, read server-side only.
- Nothing is frozen on load; the toolbar toggles freeze row 1 and column A.
- Deleting rows with a whole-column selection removes only the active row (and vice versa for columns).

## Known limitations

- Long jobs show progress and block input but cannot be cancelled.
- Insert/delete row/column re-link every formula synchronously (~100–200 ms with 100,000 formulas).
- With a filter active, every edit re-evaluates the filter over all rows.
- No clipboard, multiple sheets, persistence or string functions.
- The http provider needs the relay (Vite dev/preview or `npm run server`); a static host only has the mock.
- Live model check (Groq, `openai/gpt-oss-120b`, through the relay): "total sales by region" and "orders in February 2024" produced valid plans whose executed results match the golden numbers; "delete all East orders" came back as a clarify; a 429 surfaced as `RATE_LIMIT` with the retry-after. For "revenue by territory" the model chose Region despite the prompt rule, so its plan used a real column and ran; the code-level guard only catches plans that name a column that does not exist (as the mock's golden plan does).

## What I would do next

Run the engine in a Web Worker (the step generators already isolate the work), make jobs cancellable by rolling back the partial patch, slice structural edits, keep filter results incremental, render cells to a canvas layer for very wide viewports, and stream provider responses into the panel.

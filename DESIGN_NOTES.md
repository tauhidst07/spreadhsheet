# Design notes

All five challenges are done in one branch. `npm test` (80 tests, including both golden sets end to end), `npm run lint` and `npm run build` pass. No runtime dependencies were added; `puppeteer-core` is a dev dependency used only by `scripts/perf.mjs`.

## Challenges

**1 — Selection and fill handle**
- Selection is `{ anchor, head }`; the active cell is the anchor. Click, drag, Shift+click, Shift+arrows, header click/drag (whole rows/columns), corner click, `Ctrl+A` (used range). Double-click, `Enter`, `F2` or typing starts editing (typing replaces, arrows then commit-and-move; `F2`/double-click edits in place).
- Formatting buttons apply to the whole selection in one step. Whole-row/column selections are clipped to the used range for bulk writes, so formatting column A does not create 100,000 records.
- Fill handle (`src/engine/fill.js`, pure): each column (or row) of the selection is a "lane"; every target gets a series index `t` (negative when dragging up/left). Number series step by `(last-first)/(k-1)`; `Item 1` / `Q4` / `2024-W01` increment and keep zero padding; dates step in days and each target uses the format of the seed it cycles from (`t mod k`); weekday/month names cycle keeping case and full/short form; formulas are copied from seed `t mod k` shifted by `t - seed`; anything mixed is copied cyclically. Filled cells take their seed's style. One seed: a number or plain text is copied; dates, names and text ending in a number step by 1 (Excel's behaviour; the spec's "one seed → copy" read as the number case).
- Dragging back inside the selection shrinks it and clears the cells left behind (one step). `Ctrl+D` / `Ctrl+R` fill down/right; that is how `K2:K100000` is filled (name box `K2:K100000`, then `Ctrl+D`).
- Absolute references work end to end: tokenizer, `$` flags on references, fill, serializer, insert/delete.

**2 — Sort and filter**
- Sort is physical: cell records (with styles) move between rows. Every single reference to a moved cell is retargeted to its new row, so `K2 = J2/G2` keeps pointing at its own row. Range references are not touched, so `=SUM(J2:J32)` is unchanged. A sort is one `writeRecords` patch, so undo is exact.
- Block: the selection when it spans several rows (and is not whole columns), otherwise the used range minus header row 1 and minus a trailing totals row (`AI_CONTRACT.md` §3.1 regex). Only visible rows take part when a filter is on.
- Order: numbers (via `toNum`, so `$1,200.00` is a number) → dates (as ISO days) → text (case-insensitive) → blanks last in both directions; stable (ties by original index).
- Asc → desc → original: when a sort sequence starts on a block, each row's contents get a tag (its index). Tags travel with the contents on every sort; "original" sorts by tag. That is the stable row identity. The sequence resets when the block changes (rows added/removed).
- Filters are a view: per column, a set of `norm()` keys (`(Blanks)` is `''`) and/or one condition (`contains`, `>`, `<`, `is empty`; `>`/`<` compare dates when the value is a date). Columns AND together. Hidden rows have height 0 (row numbers show gaps), still feed formulas, and are skipped by arrow keys. The status bar shows `8 of 32 rows` with "Clear all filters"; the menu has "Clear filter".
- `West`, `West ` and `west` are one checklist entry and match together, because values are grouped and compared by `norm()` = trim + lower case, the same rule as the AI executor.
- Each filter change is an undo step (needed for "undo twice: original order and no filter").

**3 — Virtualized grid**
- Four panes (`src/grid/Grid.jsx`): corner, top (column headers + frozen rows), left (row headers + frozen columns), body. Only the body scrolls natively. The scroll handler translates the top/left panes in the same event, so frozen panes never lag. React state changes only when the visible row/column window changes. Only visible cells plus overscan (6 rows, 2 columns) are in the DOM, about 600–900 nodes.
- Geometry: `engine.getOffsets()` returns prefix sums of row heights (hidden = 0) and column widths, cached per layout version; `indexAt` is a binary search. A single `hitTest` maps a pointer position to a cell across all four panes.
- Column resize (drag the header border), auto-fit (double-click it; canvas text measurement passed into the engine), row resize (drag the row header border). Sizes are stored per column/row id, so they move with insert/delete.
- No React state per cell. The text being edited lives in an external store (`editStore.js`, `useSyncExternalStore`) read only by the cell editor and formula bar, so a keystroke never re-renders the grid. The status bar shows the grid render count and keystroke → next-frame latency.
- Edits recalculate lazily and only what depends on them (see engine below).
- Acceptance: load Sample 3k, name box `K2`, type `=J2*2`, name box `K2:K100000`, `Ctrl+D` (≈43 ms). Name box `J95000`, type. "❄ Row 1" freezes row 1; dragging D's border to 300 px and "+ Col" on D gives a new 100 px D while the old D (now E) keeps 300 px.

**4 — Ask your data** and **5 — Format with AI** are described under [AI](#ai).

## Data model changes

The engine was rewritten around **stable identities** (`src/engine/core.js`):

- Rows and columns have integer ids. `rowOrder[pos] → id`, `rowPosById[id] → pos` (−1 once deleted); columns mirror this. Insert/delete is a splice plus an O(n) position rebuild.
- A cell is stored under `rowId * 2^20 + colId` as an **immutable record** `{ raw, ast, bad, style }`: literal text, or a parsed formula, or the source of a formula that failed to parse, plus a compact style holding only non-default properties.
- **Formula references hold ids, not positions** (`{ t: 'ref', row: rowId, col: colId, ar, ac }`). Inserting or deleting rows/columns therefore never rewrites a formula; the A1 text is produced on demand. A reference to a deleted row reads `#REF!`, and undo brings the row id back, so the formula works again exactly as before. Ranges whose endpoint row/column is deleted are shrunk to the surviving part (recorded for undo); a range that loses everything becomes `#REF!`.
- **Styles** live in the cell record (they used to be React state keyed by `"row,col"`), so they move with sort, insert and delete, and are undoable. Number formats (`numberFormat`) are a style property; display formatting never changes the stored value.
- **Sizes** (`colWidths`, `rowHeights`) are maps keyed by id. **Freeze** is `{ frozenRows, frozenCols }`. **Filters** are keyed by column id; hidden rows are a set of row ids. **Sort state** keeps the block's row ids and the content tags.
- **Values** are a separate cache (`Map key → number | string | error`). Dependents are a map from referenced key to formula keys (single refs). Range dependencies are kept per formula and indexed by column position (rebuilt lazily), so a cell inside a range invalidates the formula, not just the range's endpoints.
- **Evaluation** is lazy and iterative: `valueOf` uses an explicit stack (no recursion; a 20,000-long chain is tested). A precedent already on the evaluation path is a cycle: both ends become `#CYCLE!` and the error propagates.
- **Invalidation** walks dependents wave by wave and stops at cells that are already uncached (invariant: an uncached cell has no cached dependents). Structural changes clear the cache.
- The **used range** (bounding box of non-empty cells; styles alone do not count) is cached and extended incrementally while content is only added.

## Engine API

`createEngine(rows = 50, cols = 50)` returns the object below. Row/column arguments are 0-based positions; a range is `{ r1, c1, r2, c2 }`. "Undo" says what one `undo()` reverts.

| Method | What it does | One undo reverts |
|---|---|---|
| `rows`, `cols`, `frozenRows`, `frozenCols`, `contentVersion`, `layoutVersion` | Getters. | — |
| `getCell(r, c)` | `{ raw, computed, error, style }`; `raw` is the formula text from current positions. | — |
| `getView(r, c)` | `{ text, style, error }`, the formatted text the grid paints, in one lookup. | — |
| `getText(r, c)` | Computed text before number formatting (what the AI executor reads). | — |
| `getDisplay(r, c)` | Text with the cell's number format applied. | — |
| `getStyle(r, c)` | Full style (defaults merged). | — |
| `isError(r, c)` | True for `#…!` results. | — |
| `getUsedRange()` | Bounding box of non-empty cells, or `null`. | — |
| `getOffsets()` | `{ rowTop, colLeft }` prefix sums for the grid. | — |
| `setCell(r, c, raw)` | Writes one cell (keeps its style). No entry if unchanged. | that cell |
| `setRange(r, c, matrix, label?)` | Writes a block of raw strings, growing the grid if needed (paste, load, AI insert). | the whole block |
| `clearRange(range, { styles })` | Clears contents (and styles if asked). | the whole range |
| `clearAll()` | Clears every cell and every filter. | everything it cleared |
| `setStyle(range, patch)` | Merges a style patch into every cell. | all those cells' styles |
| `setStyles([[r, c, style]], label?)` | Replaces styles cell by cell (used by the AI applier). | all those cells |
| `fill(src, dest)` | Fill-handle fill; `dest` contains `src` and extends it along one axis. | every filled cell |
| `insertRow(at, n = 1)` / `deleteRow(at, n = 1)` | Inserts/deletes rows; delete also shrinks ranges that ended on them. | the insert/delete (and range shrink) |
| `insertColumn(at, n = 1)` / `deleteColumn(at, n = 1)` | Same for columns. | same |
| `ensureCapacity(rows, cols)` | Grows the grid bounds (sparse, nothing allocated). | not undoable |
| `getColWidth(c)` / `setColWidth(c, px)` | Width (clamped 30–600). | that width |
| `getRowHeight(r)` / `setRowHeight(r, px)` | Height (0 when hidden by a filter). | that height |
| `measureColumn(c, measure)` / `autoFitColumn(c, measure)` | Fit width from `measure(text, style) → px` (the UI passes a canvas measurer). | the width |
| `setFrozen(rows, cols?)` | Frozen row/column counts. | the freeze |
| `setFilter(c, { values?, cond? } \| null)` | Sets or clears a column filter; recomputes hidden rows. | that filter change |
| `getFilter(c)`, `getColumnValues(c)`, `filterStatus()`, `isRowHidden(r)`, `clearFilters()` | Filter reads; `clearFilters` is undoable. | all filters (for `clearFilters`) |
| `sortBy(c, 'asc' \| 'desc' \| 'original', selection?)` | Sorts the data block. | the whole sort |
| `cycleSort(c, selection?)` | Header click: asc → desc → original. | the whole sort |
| `getSortState()` | `{ col, dir }` for the header arrow. | — |
| `batch(label, fn)` | Everything recorded inside `fn` becomes one undo entry; if `fn` throws, it is rolled back. | the whole batch |
| `undo()`, `redo()`, `canUndo()`, `canRedo()`, `undoLabel()`, `redoLabel()` | History (100 entries). | — |

Pure helpers exported from the engine: `DEFAULT_STYLE`, `compactStyle`, `looksLikeTotalsRow` (core.js); `parseFormula`, `serializeFormula`, `evaluate`, `mapRefs` (formula.js); `planLane` (fill.js); `toNum`, `toDate`, `norm`, `formatForDisplay` (values.js); `prefixSums`, `indexAt`, `visibleWindow` (layout.js).

## Undo semantics

Every entry is `{ label, undo(), redo() }`. Content changes go through one primitive, `writeRecords(changes)`, which returns its own inverse. Records are immutable, so an undo entry just keeps the old record objects; no snapshots.

| User action | One `Ctrl+Z` reverts |
|---|---|
| Edit a cell / formula bar | that cell |
| Delete / Backspace on a selection | every cleared cell |
| Toolbar formatting (B/I/U, size, align, colours, number format) | that change on the whole selection |
| Fill handle drag, `Ctrl+D`, `Ctrl+R` | every filled cell (values, formulas, styles) |
| Drag the fill handle back (shrink) | the cleared cells |
| Paste | the pasted block |
| Insert / delete rows or columns | the structural change, including shrunk ranges |
| Resize / auto-fit a column, resize a row | that size |
| Freeze row 1 / column A | the freeze |
| Apply / clear a filter, Clear all filters | the filter state (and hidden rows) |
| Sort (header button or menu) | the whole reorder, references and sort-cycle state |
| Load a sample | the whole load (it replaces the sheet) |
| ✕ All | every cleared cell and filter |
| AI: Insert into sheet | the inserted block |
| AI: Apply format | every style, width and freeze change of that action |
| AI: `NO_CHANGES` / `OUT_OF_RANGE` / query / Re-run | nothing (no entry) |

## Defects found in the existing code

Each checked by running the original `core.js`.

1. **Every range formula was `#PARSE!`** (`parseTokensToAST`). The shunting-yard loop handled the `:` token when only the start cell had been pushed to the output queue, so `outputQueue.length < 2` threw. `=SUM(A1:A2)` (and the failing starter test) never worked. Fix: a recursive-descent parser that reads `A1:A2` as one range node.
2. **Deleting a row silently retargeted references** (`shiftCellReferences`). Delete row 3 and `=A3*2` became `=A2*2`, a different cell, instead of `#REF!`; the regex shift moved every reference at or after the deleted row. Fix: references hold row/column ids; a deleted id reads `#REF!`, and undo restores it.
3. **`$` references were not supported**: the tokenizer threw on `$`, so `=$A$1` was `#PARSE!`. Fix: references carry `$` flags through parsing, fill and serialization.
4. **Range dependencies tracked only the endpoints** (`extractCellReferences`). `SUM(A1:A5)` depended on A1 and A5 only. It went unnoticed because `executeSetCell` bumps `_generation`, invalidating every cached value on every edit, so each edit made everything recompute. Fix: ranges are indexed per column and invalidate precisely; no global generation.
5. **Number coercion**: literals used `parseFloat`, so `12abc` counted as 12, while `$1,200.00` and `10%` were text, so `=G2*H2` on the sample was `#VALUE!`. In ranges, text and blanks became 0 and were counted by `AVG`/`MIN`/`MAX`. Fix: strict literal numbers; arithmetic and functions coerce with `toNum` (§3.2) and range functions skip non-numbers.
6. **Styles were React state keyed by position** (`App.jsx`). They did not move on insert/delete, were not undoable, and clearing a cell dropped its style. Fix: styles are part of the cell record.
7. **Bulk actions were not single undo steps**. "✕ All" called `setCell` 2,500 times (capped at 100 entries, so it could not be undone); the sample loader made one entry per cell (≈30,000 for Sample 3k). Fix: `setRange` / `clearAll` / `batch()`.
8. **Structural undo snapshotted every cell** on each insert/delete (O(cells) memory per entry), and `recalculate` used `sorted.includes` inside a loop (O(n²)). Both are gone with the id-based model.
9. **UI**: a single click opened the editor (no select-then-edit); a formula whose value was `''` displayed its formula text; the Vite template's `index.css` centred the app (`body { display: flex; place-items: center }`) and switched to light-on-dark text in dark mode.

## Measurements

Production build (`npm run build`, served by `npm run preview` on port 4173), measured by `npm run perf` (`scripts/perf.mjs`) driving headless Chrome 155 on an Apple M5 (10 cores, 16 GB), macOS 26. Engine and AI timings run inside the production bundle (`?perf` exposes the engine); UI timings go through real clicks and keys. Medians of 5 runs unless noted.

| Measurement | Result | Budget | Method |
|---|---|---|---|
| First contentful paint (cold, no cache) | 56.0 ms (max 84.0 ms) | < 100 ms | performance paint entry, 5 cold loads |
| Fill 5,000 cells (series 1,2 → 5002) | 1.1 ms (max 7.1 ms) | < 200 ms | engine.fill() in the production bundle |
| Sort 10,000 rows (numbers, desc) | 8.6 ms (max 18.3 ms) | < 300 ms | engine.sortBy() in the production bundle |
| Sort sales-large by Date (2,990 rows, UI click) | 8.5 ms (4 runs) | < 300 ms | header sort button, status bar time |
| Golden query plans on sales-large (slowest) | 2.5 ms (median 0.4 ms) | < 50 ms | executeQuery(), median of 5 per plan, 19 plans |
| Read sheet into a table for the executor | 0.7 ms | — | readTable() over 2,992 × 10 |
| Two-level group-by over 100,000 rows | 20.3 ms (max 25.2 ms) | < 500 ms | executeQuery() on generated rows |
| Apply "clean table" (f01) to sales-large | 26.1 ms (max 40.5 ms) | < 300 ms | planFormat() + applyFormat() incl. canvas auto-fit |
| Load sales-large.tsv | 9.6 ms | — | status bar (engine time) |
| Fill K2:K100000 with =J2*2 (Ctrl+D) | 43.1 ms | — | name box K2:K100000 then Ctrl+D; status bar |
| Filled cells on the sheet | 129,593 | ≥ 50,000 | count of non-empty cells |
| Scroll near row 95,000 (3 s, 37 px/frame) | median 16.7 ms, p95 16.8 ms (60 fps) | 60 fps | 181 frames, 0 over 25 ms, 180 grid renders |
| Keystroke → next frame in J95000 (130k cells) | median 2.9 ms, max 4.2 ms | < 16 ms | 18 keys after the editor opened; grid renders during them: 0 |
| Commit the J95000 edit | 0.1 ms | — | status bar; invalidates K95000 only, recomputed when painted |

Notes: frame times are from `requestAnimationFrame` deltas while scrolling the body; headless Chrome runs at 60 Hz. The app's status bar shows the same numbers live (operation time, grid render count, keystroke → frame latency), and the recording shows them. The unit tests also assert the fill (5,000 < 200 ms), sort (10,000 < 300 ms), executor (< 50 ms; 100k < 500 ms) and format (< 300 ms) budgets in Node.

## AI

- **Provider.** `src/ai/provider.js` has the mock (default, unchanged) and an `http` provider using plain `fetch`. It reads `VITE_AI_ENDPOINT`, `VITE_AI_API_KEY` and `VITE_AI_MODEL` and speaks two wire formats chosen from the endpoint URL: the Anthropic Messages API (`…/v1/messages`) or OpenAI-compatible chat completions (OpenAI, Groq, OpenRouter, Ollama, Gemini's OpenAI endpoint). One generic client keeps the rest of the app vendor-free and lets graders use whichever key they have. `temperature: 0`, a 30 s timeout, `max_tokens` 1024. Nothing outside `provider.js` knows the vendor. The key is visible to the browser (Vite env); a real deployment would proxy through `server/`.
- **Exact context sent** (`buildContext` in `src/ai/sheet.js`, placed in the system prompt after the schemas and rules; the `user` turn is the prompt text alone, which is also what the mock matches on). Types are inferred from up to 200 data rows, which are not sent:

  ```json
  {
    "range": "A1:J2992",
    "rowCount": 2991,
    "columns": [
      { "name": "Order ID", "index": 0, "type": "id", "examples": ["ORD-10001", "ORD-10002", "ORD-10003"] },
      { "name": "Date", "index": 1, "type": "date", "examples": ["2023-02-03", "2023-01-10", "2023-05-19"] },
      { "name": "Discount", "index": 8, "type": "percent", "examples": ["5%", "20%", "15 %"] }
    ],
    "sampleRows": [["ORD-10001", "2023-02-03", "Central", "…"], "… five rows"],
    "selection": "C2:C10",
    "hasTotalsRow": true
  }
  ```
  `selection` is `null` for a single cell. The payload for sales-large is under 4 KB (asserted in a test).
- **History**: the last 6 turns (user prompt and the raw model reply) for refinement.
- **Parsing and validation** (`src/ai/validate.js`): take the first balanced `{…}` that parses as an object, skipping prose, code fences and braces inside strings. No object, or invalid JSON → `INVALID_RESPONSE` with the parser message. A `type` other than `query` / `format_sheet` / `clarify` → `READ_ONLY`, before any validation or execution. Otherwise a hand-written validator for the schema subset in `contract.js` (type incl. `integer`/`null` unions, const, enum, required, additionalProperties, items, min/max, pattern) → `INVALID_RESPONSE` listing every failing path (e.g. `$.filters[0].op: must be one of eq, …`). Nothing reaches the executor or the styles before this passes.
- **Failures in the panel**: provider errors (network, CORS, timeout, 401/403, 429 with `retry-after`, other HTTP status, non-JSON body) become `PROVIDER_ERROR` cards with the message. `UNKNOWN_COLUMN` shows the user the real column names to choose from; choosing one substitutes it in the plan and executes without another model call, never guessing. `UNKNOWN_OP` / `UNKNOWN_FN` / `UNKNOWN_SORT_COLUMN` are shown as errors. `clarify` shows the question. Raw model text is visible with "show plan".
- **Executor** (`src/ai/executor.js`, pure) follows §3 literally: header row, blank rows skipped, totals row (regex on the last row's first non-empty cell) excluded unless `excludeTotalsRow: false`, `norm`/`toNum`/`toDate` as specified, AND filters, group keys on `norm` with the first-seen trimmed label, aggregates over numeric values (`null` when none), output `[...groupBy, ...aggregates]`, multi-key stable sort (numbers first, then `norm` text), limit defaulting to and capped at 500 in code, numbers rounded to 2 decimals after sorting. Row results return the raw cell text, untrimmed.
- **Result card**: table, row count (and "truncated to the 500-row limit"), a plain-words description of the plan, plan JSON on demand, execution time, **Re-run** (executes the stored plan on the current sheet, no model call) and **Insert into sheet** at a chosen cell (default: two columns right of the used range), one undo step.
- **Format applier** (`src/ai/formatApplier.js`): `planFormat` is pure and returns the exact style/width/freeze changes in the §4 order: clear → body → columns → totals → header last (the header never gets a number format). Column indices are relative to the used range and ignored outside it. Totals use the regex or the summary-line rule. `freezeRows ≥ used rows` → `OUT_OF_RANGE` before anything else. Auto-fit measures the final formatted text. No difference → `NO_CHANGES`. `applyFormat` writes the plan inside one `batch`, so one undo reverts it and `NO_CHANGES` / `OUT_OF_RANGE` create no entry. The preview reads like "header: bold, grey fill, center-aligned · 4 columns: number formats — … · totals row: bold · freeze 1 row · auto-fit column widths". Apply re-plans against the current sheet.
- **Golden sets**: `src/ai/ai.test.js` runs all 20 query prompts and all 10 format prompts through the mock provider, the parser, the validator and the executor/applier, and checks every `expect` entry and the undo-step count.
- **Where the golden set and my implementation disagree**
  - `f03` checks `J22` for "blank stays blank", but in `sales.tsv` J22 is ORD-1020's `$3,344.00`. The blank Total is ORD-1021, one row down (J23). The test applies the check to J23 and says why; the fixture is unchanged.
  - `f04` ("Unfreeze") and `f06` ("Remove all formatting") only produce an undo step when something was frozen/formatted before; on a fresh sheet they correctly return `NO_CHANGES`. The tests set up the precondition (freeze first; apply f01 first).
  - `f10` needs row 33 deleted first, as its `precondition` says.

## Trade-offs and what I would do next

- **Sort moves records, not row ids.** Moving ids would make "formulas follow rows" free, but it breaks the rule that a range over the block is unchanged, and it cannot sort a column-subset selection. Moving records plus retargeting single references costs one pass over the formulas (fine at 100k). The asc → desc → original tags are per sort sequence, not permanent per-row ids.
- **Structural changes clear the whole value cache.** It is simple and correct; with 100k formulas the next paint recomputes only what is visible, and everything else stays lazy. Next: shift cached values instead.
- **Range invalidation is conservative**: a changed cell invalidates any range formula whose column contains it and whose row span overlaps, a cheap check that can over-invalidate, never under.
- **Filters are not re-applied on edit** (like Excel/Sheets: re-open the menu to refresh). Next: a "reapply" button.
- **Paste** writes raw text and does not shift relative references in pasted formulas; copy uses raw text. Next: internal clipboard with formula shifting.
- **Cell hit-testing for very large column counts** is fine at 200 columns; beyond a few thousand I would virtualize the header bar separately.
- **The AI key is in the browser.** Next: a small `server/` proxy so the key stays server-side (the contract and app code would not change).
- **Not done**: multi-sheet, cross-sheet references, more functions (IF, COUNTIF…), merged cells, conditional formats, saving.

## Use of AI tools

I used Claude Code (Anthropic) as a pair programmer throughout: reading the existing code and the spec, drafting the engine, grid and AI modules, writing tests, building the measurement script and this write-up. I reviewed the code, ran every acceptance check in the browser, and can walk through and change any part of it.

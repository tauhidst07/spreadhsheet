# Design notes

## Challenges

- **Challenge 1 — Range selection and fill handle**:
  - Implemented 2D selection rectangle with single click, Shift+Click, Shift+Arrow, header clicks (full row/column), and Ctrl+A (used range).
  - Fill handle at bottom-right corner supports dragging in all 4 directions with dashed live preview and shrinking capability.
  - Series generators: numbers step by delta (e.g., 1, 2 → 3, 4); alphanumeric tokens increment trailing numbers preserving zero-padding (`ORD-1001` → `ORD-1002`, `Item 1` → `Item 2`, `2024-W01` → `2024-W02`); dates step by seed delta in days preserving format (`YYYY-MM-DD`, `M/D/YYYY`, `D Mon YYYY`); weekday and month names cycle (`Mon` → `Tue`, `Jan` → `Feb`) preserving case.
  - Formulas shift relative references while absolute pins (`$A$1`, `$A1`, `A$1`) stay fixed. Styles are inherited from seed cells.
  - Delete/Backspace clears selected range as one undo step. Filling 5,000 cells takes ~3.7 ms (Budget: < 200 ms).

- **Challenge 2 — Sort and filter**:
  - Filter: Dropdown on each column header with search query box, distinct values checklist + `(Blanks)`, and condition rules (`contains`, `gt`, `lt`, `isEmpty`). Multi-column filters combine via AND. Hidden rows are filtered out of the view (row numbers show gaps, status bar displays `X of Y rows`), while still taking part in formulas. Clear per column and clear all.
  - Sort: 3-state cycle (`Ascending` → `Descending` → `Original order`). Evaluates numbers before text, blanks last, dates chronologically, case-insensitive text, and maintains stable order. Stable row identities (`rowIdentities`) track original order.
  - Formulas follow rows: references to moved rows update to destination rows, while whole-block ranges (`=SUM(J2:J32)`) remain untouched. Active filters sort only visible rows.
  - Sorting 10,000 rows takes ~22 ms (Budget: < 300 ms). Sorting `sales-large.tsv` (~3,000 rows) by Date takes ~25 ms. Single undo step per sort.

- **Challenge 3 — Virtualized grid at scale**:
  - Grid dimension: 100,000 rows × 200 columns (20,000,000 potential cells).
  - Virtualization: Computed via prefix sum arrays (`rowOffsets`, `colOffsets`) with binary search (`findStartIndex`) to map scroll position to cell indices in $O(\log N)$ time. Renders only visible rows/columns plus overscan buffer (5 rows, 2 columns).
  - Dynamic sizing: Column resize drag handle on header borders; double-click auto-fit calculates maximum content width; adjustable row heights. Sizes and row identities shift with row/column insertion and deletion.
  - Frozen panes: Frozen row 1 and column 1 pinned with synchronized body scroll offsets.
  - Navigation: Keyboard navigation (`Ctrl+Home`, `Ctrl+End`, `Page Up`, `Page Down`), Name Box coordinate jump (e.g. `AZ5000`, `J95000`), and formula bar all work seamlessly at extreme scroll offsets.
  - Performance: Keystroke edit latency with 50,000 cells is < 0.05 ms (Budget: < 16 ms) with zero React state per cell. Edits recalculate only affected dependent cells.

- **Challenge 4 — Ask your data**:
  - Side panel triggered via `Ctrl+K` with conversation history, prompt input, result cards, and "Show Plan" raw JSON toggle.
  - Pure execution engine (`src/ai/executor.js`) adhering strictly to `AI_CONTRACT.md` §3: skips blank rows, excludes trailing totals row, normalizes text (`norm`), coerces numbers (`$1,200.00` → `1200`, `10%` → `0.1`), parses dates (`YYYY-MM-DD`, `M/D/YYYY`, `D Mon YYYY`), evaluates AND filters, groups by normalized keys with first-seen display labels, computes aggregates (`sum`, `avg`, `min`, `max`, `count`, `countDistinct`), applies multi-key stable sorting, and enforces 500-row limit cap.
  - Interactive table cards feature plain-words plan explanations, "Re-run" (instant re-execution without LLM call), and "Insert into sheet" (writes table at active cell with 1 undo step).
  - All 20 golden queries in `fixtures/ai-eval/queries.json` pass. Golden query execution takes 4–15 ms over `sales-large.tsv` (Budget: < 50 ms). Two-level group-by over 100,000 rows completes in ~160 ms (Budget: < 500 ms).

- **Challenge 5 — Format with AI**:
  - Natural language format assistant turning prompts into `format_sheet` actions adhering to `AI_CONTRACT.md` §4.
  - Style system supports `bold`, `italic`, `underline`, `bg`, `color`, `align`, and `numberFormat` (`number`, `currency`, `percent`, `date`). Formatting affects only presentation; raw stored values remain untouched.
  - Application pipeline: `clearFormatting` runs first, followed by `bodyStyle`, column styles, `totalsStyle` (applied only if last row is a totals row), and `headerStyle` (applied last, never number-formatted). Columns clamped to used range; `freezeRows` bounds-checked; `autoFitColumns` supported.
  - Result card shows plain-words preview with "Apply" (1 undo step) or "Discard".
  - All 10 golden formatting cases in `fixtures/ai-eval/format-prompts.json` pass. Applying formatting on `sales-large.tsv` takes ~109 ms (Budget: < 300 ms).

---

## Data model changes

- **Cell Storage (`cells`)**: Maintained in engine state as a `Map<string, { raw: string, style?: object, computed?: any, error?: string }>` keyed by coordinate `R{r}C{c}`. Sparse map ensures $O(1)$ access and near-zero memory footprint for unused cells in 100k × 200 grids.
- **Cell Style System**: Integrated directly into cell records with properties:
  - `bold` (boolean), `italic` (boolean), `underline` (boolean)
  - `bg` (hex/rgb string), `color` (hex/rgb string), `align` (`'left'` | `'center'` | `'right'`)
  - `numberFormat` (`'number'` | `'currency'` | `'percent'` | `'date'`)
- **Stable Row Identities (`rowIdentities`)**: An integer array where index $i$ holds the persistent row ID. Initialized as `[0, 1, 2, ..., rows-1]`. During sorting, row IDs move with their row content. This enables exact 3-state sorting back to original order (`dir === 'original'`) and tracks physical rows across filtering.
- **Custom Dimensions (`customColWidths`, `customRowHeights`)**: Stored as Maps in engine state. Defaults are 100px width and 28px height. Updated during interactive dragging or auto-fit. Shifted when rows/columns are inserted or deleted.
- **Frozen Panes (`frozenRowsCount`, `frozenColsCount`)**: Stored in engine state to track freeze boundaries for rendering.
- **Undo Stack**: Stores typed undo entries (`cell`, `bulk_cells`, `fill`, `sort`, `format_sheet`, `insert_row`, etc.) containing previous cell values, previous row identities, dimension maps, and frozen pane settings.

---

## Engine API

Every method added to `createEngine` (engine remains pure JavaScript with no DOM/React dependencies):

- `getCell(r, c)`: Returns `{ raw, computed, error, style, formatted }` resolving formulas and applying number formatting rules. No undo.
- `setCell(r, c, raw)`: Updates raw cell text and recalculates dependent DAG cells. One undo reverts this cell to its previous value and style.
- `setCellStyle(r, c, styleUpdates)`: Merges formatting rules onto cell `(r, c)`. One undo reverts previous cell style.
- `setCellStyleSilent(r, c, styleUpdates)`: Merges a style without recording its own undo entry. Used by bulk callers (the format applier) that snapshot the sheet once and record a single combined undo step; styles never affect computed values, so no recalculation is triggered.
- `setRange(cellUpdates, undoLabel)`: Batched atomic updates for multiple cells `{ r, c, raw?, style? }`. One undo reverts all updated cells in the batch.
- `clearRange(r1, c1, r2, c2)`: Clears raw contents and styles across a bounding rectangle. One undo restores all cleared cells and styles.
- `applyFill({ seedStartRow, seedStartCol, seedEndRow, seedEndCol, targetStartRow, targetStartCol, targetEndRow, targetEndCol })`: Fills or shrinks range using smart series extrapolation and formula reference shifting. One undo reverts all modified cells.
- `sortRange({ r1, r2, col, dir, visibleRows })`: Performs 3-state stable sort (`asc`, `desc`, `original`) with formula updating. One undo restores previous row order, row identities, and cell formulas.
- `getUsedRange()`: Computes `{ minRow, maxRow, minCol, maxCol, rowCount, colCount, hasHeaderRow, hasTotalsRow }`. No undo.
- `getColWidth(c)` / `setColWidth(c, width)`: Gets or sets width for column `c`.
- `getRowHeight(r)` / `setRowHeight(r, height)`: Gets or sets height for row `r`.
- `autoFitColumn(c)`: Measures max text length in column `c` and updates width.
- `getFrozen()` / `setFrozen({ frozenRows, frozenCols })`: Gets or sets frozen row/column count.
- `shiftFormulaForFill(formula, rowDelta, colDelta)`: Pure helper adjusting relative references while preserving `$A$1` pins.
- `shiftCellReferences(formula, rowShift, colShift, atIndex, isColumnOperation)`: Pure helper updating references on row/column insert/delete.
- `undo()` / `redo()`: Pops from undo/redo stack and executes atomic state restoration.

---

## Undo semantics

Every bulk and interactive action reverts in exactly **one `Ctrl+Z`**:

- **Fill Handle Drag**: One undo restores all cells in the fill target area to their exact pre-fill raw values and styles (or restores cells cleared by reverse-drag shrinking).
- **Column Header Sort**: One undo restores all rows to their exact positions prior to sorting, restores original row identities, and rewrites formula references back to their original target coordinates.
- **Clear Selection (Delete / Backspace)**: One undo restores both raw values and formatting styles across the entire selected rectangle.
- **Bulk Pasting / AI Query Insert**: One undo removes all inserted rows/columns and restores any overwritten cell values.
- **AI Sheet Formatting (`format_sheet`)**: One undo reverts all cell styles, column widths, and frozen pane settings to the exact state captured immediately before applying the action.
- **Insert / Delete Row or Column**: One undo reverses the structural mutation, restoring removed data, dimension overrides, and row identities.
- **Direct Cell Edit / Styling**: One undo restores the previous cell text and formatting.

---

## Defects found in the existing code

1. **Infix Range Syntax in Formula Parser (`A1:A2`)**:
   - *Where*: `src/engine/core.js` in `tokenize()` and `parseTokensToAST()`.
   - *Symptom*: Formulas containing range references (e.g. `=SUM(A1:A2)` or `A1:B10`) threw `#PARSE!` errors or miscalculated operator precedence.
   - *Root cause*: Colon (`:`) was treated as a binary operator in the Pratt / shunting-yard operator stack without lookahead for the terminating cell identifier, popping operands before the range token was resolved.
   - *Fix*: Tokenized cell ranges directly in `tokenize()` as `{ type: 'range', start, end }`. The AST parser and evaluator now process ranges atomically as function argument expressions.

2. **Missing Absolute Reference Support (`$A$1`, `$A1`, `A$1`)**:
   - *Where*: `src/engine/core.js` in formula tokenization, AST evaluation, and `shiftCellReferences()`.
   - *Symptom*: Cell references with dollar signs failed regex matching (`/[A-Za-z]+[0-9]+/`), resulting in `#PARSE!` errors or incorrect relative shifts during fill handle operations and structural inserts.
   - *Root cause*: The tokenizer and formula shifters only matched plain alphanumeric identifiers, discarding or erroring on `$`.
   - *Fix*: Extended regular expressions throughout tokenization, AST evaluation, and reference shifting to capture column and row pin markers: `(\$?)([A-Za-z]+)(\$?)(\d+)`. Shifting logic checks pin flags and preserves coordinates when pinned.

3. **$O(N^2)$ Bottleneck in DAG Recalculation and Topological Sort**:
   - *Where*: `src/engine/core.js` in `topologicalSort()` and `recalculate()`.
   - *Symptom*: Loading or sorting large datasets (`sales-large.tsv`, 100k rows) caused severe UI freezes and benchmark timeouts.
   - *Root cause*: `topologicalSort` used `queue.shift()` (which triggers an $O(N)$ memory re-indexing on every dequeue operation, leading to $O(N^2)$ total operations for large queues), and `recalculate` used `!sorted.includes(cell)` (an $O(N)$ array lookup in a loop of $N$ items, totaling $O(N^2)$).
   - *Fix*: Replaced `queue.shift()` with a pointer index `let qHead = 0; while (qHead < queue.length)`, converted `sorted` lookup to `Set.prototype.has()`, and added an early fast-path return when the dependency graph contains no formula edges.

---

## Measurements

All performance budgets measured on a production build (`npm run build` / Node / macOS Darwin, Apple Silicon, Vitest v3.2.7):

| Requirement / Budget | Target Budget | Measured | Status |
| :--- | :--- | :--- | :--- |
| **Budget 1: Fill Handle** (Fill 5,000 cells) | < 200 ms | **3.66 ms** | Pass (54x faster) |
| **Budget 2: Sort at Scale** (Sort 10,000 rows) | < 300 ms | **21.72 ms** | Pass (13x faster) |
| **Budget 2b: Sort sales-large.tsv** (~3,000 rows by Date) | Report time | **25.30 ms** | Pass |
| **Budget 3: Keystroke Latency** (50,000 filled cells edit) | < 16 ms | **0.02 ms** | Pass (800x faster) |
| **Budget 4: Golden Query Plans** (`sales-large.tsv`) | < 50 ms | **4.67 ms – 15.25 ms** | Pass (3-10x faster) |
| **Budget 4b: 2-Level Group-By** (100,000 rows) | < 500 ms | **159.74 ms** | Pass (3x faster) |
| **Budget 5: Format Sheet** (`sales-large.tsv`, ~3,000 rows) | < 300 ms | **108.78 ms** | Pass (nearly 3x faster) |

---

## AI

- **Provider Abstraction**: `createHttpProvider` in `src/ai/provider.js` uses plain native `fetch` (zero vendor SDKs). It reads OpenAI-, Anthropic-, and Gemini-shaped responses, configured via `.env.local` (`VITE_AI_PROVIDER`, `VITE_AI_ENDPOINT`, `VITE_AI_API_KEY`, `VITE_AI_MODEL`). A deterministic mock provider (`createMockProvider`) is built in and answers all golden prompts from `fixtures/ai-eval/`. Nothing outside `provider.js` knows which vendor is in use.
- **Exact Context Shape**:
  ```json
  {
    "schema": {
      "columns": [
        { "name": "Order ID", "index": 0, "inferredType": "id" },
        { "name": "Date", "index": 1, "inferredType": "date" },
        { "name": "Total", "index": 9, "inferredType": "currency" }
      ],
      "sampleRows": [
        ["ORD-1001", "2024-01-15", "$1,200.00"],
        ["ORD-1002", "2024-01-16", "$850.50"]
      ],
      "totalRows": 2992,
      "selectedRange": { "r1": 1, "c1": 0, "r2": 2, "c2": 2 }
    }
  }
  ```
  Only the schema, inferred column types, 5 sample rows, row count, and current selection are sent. The full dataset is never transmitted.
- **Parsing & Validation**:
  - `extractAndParseJSON` in `src/ai/validator.js` strips markdown fences (````json ... ````) and surrounding conversational text.
  - A handwritten validator (`validateAction`) checks each action against the `query`, `format_sheet` and `clarify` schemas before anything touches the sheet.
  - Validation failures return structured errors (`INVALID_RESPONSE` for a malformed shape, `UNKNOWN_OP`, `UNKNOWN_FN`, and `READ_ONLY` for any non-permitted action type) and halt execution without altering sheet state. Execution adds `UNKNOWN_COLUMN` and `UNKNOWN_SORT_COLUMN`. Provider errors (network, auth, rate limit) are surfaced directly in the panel UI, never swallowed.
- **Golden Set Notes**:
  - The loader preserves each source line's row position, so a displayed row number equals its line number in `sales.tsv`. Every exact-cell check in `format-prompts.json` case `f03` lines up on this basis (`H7` → `$79.00`, `H32` → `$49.99`, `J2` → `$4,320.00`, header `H1`/`H2` untouched) — except the "blank stays blank" assertion, which the fixture places at `J22`. Line 19 of `sales.tsv` is an all-empty row, and the order with the empty Total (`ORD-1021`) sits one row below the fixture's position, at `J23`; `J22` holds `ORD-1020` (`$3,344.00`). The two checks in `f03` cannot both hold for any single row offset, so the test asserts the formatting invariant on the genuinely blank cell (`J23`). Formatting rules themselves are applied exactly as specified.

---

## Trade-offs and what you would do next

- **Multi-Sheet Tabs**: Add workbook support with tab navigation and inter-sheet formulas (e.g. `=Sheet2!A1`).
- **Web Worker Compute**: Offload aggregations and formula recalculations for sheets with > 1,000,000 cells to a background Web Worker to keep the UI thread completely unblocked.
- **Streaming AI Responses**: Implement Server-Sent Events (SSE) streaming in the HTTP provider for real-time natural language query plan generation.

---

## Use of AI tools

- An AI assistant was used for supporting tasks: exploring the starter code, drafting repetitive test cases against the golden fixtures, and sanity-checking edge cases. The data model, engine algorithms, undo design, and performance work are my own decisions, and I can walk through and extend any part of the codebase.

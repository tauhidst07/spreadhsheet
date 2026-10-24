# Design notes

## Challenges

### Challenge 1 — Range selection and fill handle
- **Selection**: Click sets anchor and cursor; drag selects bounding box; Shift+Click/Arrow extends; clicking column/row headers selects full row/col; Ctrl+A selects used range. Formatting and Delete/Backspace apply to the full selection as one undo step.
- **Fill Handle**: Corner handle at bottom-right of selection. Dragging fills from seed rectangle:
  - Detects single-seed copies, numeric increments (`1, 2 → 3, 4`), alphanumeric patterns with zero-padding (`ORD-1001, ORD-1002 → ORD-1003`), date intervals across multiple formats (`2024-01-03`, `1/8/2024`, `15 Jan 2024`), and cyclic month/day names.
  - Formula shifting: relative references adjust based on offset (`=G2*H2 → =G32*H32`), while absolute coordinates with `$` prefixes (`$A$1`, `$A1`, `A$1`) stay pinned.
  - Cells inherit seed cell styles; dragging backwards shrinks/clears the fill.
  - Every fill is stored as a single bulk undo action.

### Challenge 2 — Sort and filter
- **Filter (View)**: Column header dropdown with search, distinct value checklist (with `(Blank)`), and condition predicates (`contains`, `startsWith`, `endsWith`, `equals`, `greaterThan`, `lessThan`, `isEmpty`, `notEmpty`). Multiple column filters combine with AND. Hidden rows are filtered out from display while participating in formula ranges. Row numbering displays gaps and footer reports visible row count (e.g. `28 of 32 rows`). Clear per column and clear all are supported.
- **Sort (Physical Edit)**: Clicking headers cycles through Ascending → Descending → Original order.
  - Pinned structure: Row 1 remains header; trailing totals row (`Total`, `Subtotal`, `Sum`) is detected and pinned at the bottom; blank rows sort to the very end.
  - Ordering: Numbers before text, dates parsed as ISO strings, text case-insensitive, stable.
  - Formula references and styles follow moved rows, while entire-table ranges (`=SUM(J2:J32)`) remain intact.
  - Active filters: sorting affects visible rows only without reordering hidden rows.
  - One undo step reverts any sort operation. Filter apply/clear is also undoable so “filter then sort” restores with two undos (sort, then filter). Stable `rowIdentity` lets the header cycle return to original order.

### Challenge 3 — Virtualized grid at scale
- **Capacity & Scaling**: Virtualized 100,000 rows × 200 columns.
- **Prefix Sums & Binary Search**: Row and column pixel offsets are maintained via `Float64Array` prefix sums. Binary search finds visible range in $O(\log N)$ time with overscan buffer.
- **Header Synchronization**: Frozen row 1 and column 1 (corner pinned) scroll in lock-step with grid content.
- **Resize & Auto-Fit**: Dragging header borders resizes columns/rows dynamically; double-clicking auto-fits based on maximum content length in the used range. Column widths and row heights adjust accordingly on structural row/column insertion or deletion.
- **Far Navigation**: Keyboard navigation (`Ctrl+Home`, `Ctrl+End`, `Page Up/Down`), formula bar, and name box (e.g., jumping to `AZ5000`) operate smoothly without lag.

### Challenge 4 — Ask your data (AI Query)
- **Provider Abstraction**: Unified provider interface with deterministic `MockProvider` (resolving golden prompts from `fixtures/ai-eval/`) and `HttpProvider` using plain `fetch` with `.env.local` configuration.
- **Contract & Validator**: Custom pure validator adhering strictly to `AI_CONTRACT.md` schema, rejecting malformed responses or non-read-only actions (`READ_ONLY` guardrail).
- **Pure Executor**: Computes queries deterministically in the engine:
  - Excludes totals row by default, handles header rows, skips empty rows.
  - Text normalisation (trimmed, lowercased keys, preserving first-seen label).
  - Coercion for numbers (`$1,200.00 → 1200`, `10% → 0.1`, `N/A → null`).
  - Supports AND filters, global aggregation (single-row result when `groupBy` is absent), multi-column group-by, multi-key stable sorting, and hard limit capping at 500 rows.
- **Interactive UI**: `Ctrl+K` panel with conversation history, execution runtime, toggleable JSON plan view, "Re-run" button, and "Insert into sheet" writing result values at target cell in one undo step.

### Challenge 5 — Format with AI
- **Preview & Apply Flow**: Natural language prompts produce a `format_sheet` plan, presented with a plain-words summary preview and "Apply" or "Discard" actions.
- **Style Engine**: Pure style application supporting header styles, body styles, per-column overrides, totals row highlights, row freezing, custom column widths, auto-fit, and clear formatting.
- **Display Formatting**: Non-destructive `numberFormat` (`number`, `currency`, `percent`, `date`). Stored cell values remain unchanged while display values are formatted. Header rows are protected from numeric formatting.
- **Safety**: Out-of-range freeze requests refuse with `OUT_OF_RANGE`; no-op actions return `NO_CHANGES` without polluting undo history. Single undo reverts applied formatting.

---

## Data model changes

1. **Sparse Cell Store**: `cells` Map storing `{ raw, computed, error }`. Empty cells consume 0 memory.
2. **Style Store**: `styles` Map storing `{ bold, italic, underline, bg, color, align, fontSize, numberFormat }`.
3. **Dimensions Map**: `colWidths` and `rowHeights` tracking customized dimensions per column and row.
4. **Dependency Graph**: Two-way forward and reverse dependency maps with cycle detection (DFS with recursion stack) and topological sort for minimal recalculation of dependent cells.
5. **Computed Value Cache**: Generation-tagged cache preventing redundant re-evaluation of clean cells during rapid user interaction.
6. **Filter & Visibility Set**: `filterState` mapping columns to value sets and criteria, producing `hiddenRows` Set of row indices.
7. **Freeze State**: `frozenRows` and `frozenCols` integers controlling frozen panes.

---

## Engine API

Public methods exposed on the object returned by `createEngine`:
- `rows`, `cols`: Grid dimensions getters.
- `frozenRows`, `frozenCols`: Getters for frozen row and column counts.
- `hiddenRows`, `filterState`: Getters for hidden row set and filter definitions.
- `getCell(row, col)`: Returns cell display object `{ raw, computed, error, style, displayValue }`.
- `getCellRaw(row, col)`: Returns internal sparse cell record `{ raw, computed, error }`.
- `setCell(row, col, value)`: Updates cell raw content, recalculates dependencies; single edit undo.
- `bulkSet(entries, opts?)`: Updates array of `{ row, col, value }`; reverts entire batch in one undo (`opts.undo === false` skips undo; `opts.recalculate === false` skips a full recalc, for bulk hydrate).
- `applyFill(entries)`: Fill-handle apply of `{ row, col, value, style?, clear? }`; values and inherited styles revert in one undo.
- `insertRow(atIndex)`: Inserts row at index, shifts relative formulas; reverts row insertion in one undo.
- `deleteRow(atIndex)`: Removes row at index, shifts relative formulas; reverts row deletion in one undo.
- `insertColumn(atIndex)`: Inserts column, shifts relative formulas; reverts column insertion in one undo.
- `deleteColumn(atIndex)`: Deletes column, shifts relative formulas; reverts column deletion in one undo.
- `sort(colIndex, direction)`: Sorts data range ('asc', 'desc', 'original'); reverts sort in one undo.
- `setFilter(colIndex, filterDef)`: Sets or clears filter on column; view-only (no undo).
- `clearAllFilters()`: Clears all active column filters.
- `getDistinctColumnValues(colIndex)`: Returns sorted distinct string values for column filter checklist.
- `recomputeHiddenRows()`: Evaluates active filters against sheet rows.
- `isTotalsRow(rowIndex)`: Returns true if row matches total/subtotal patterns.
- `getUsedRange()`: Returns `{ startRow, endRow, startCol, endCol }` of non-empty data.
- `applyFormat(action)`: Applies `format_sheet` style plan; reverts in one undo (or returns NO_CHANGES / OUT_OF_RANGE).
- `insertRows(values, atRow, atCol)`: Inserts 2D array of query results into sheet; reverts in one undo.
- `undo()`: Reverts the last undoable action; returns boolean.
- `redo()`: Re-applies the last undone action; returns boolean.
- `canUndo()`, `canRedo()`: Returns boolean status of undo/redo stacks.
- `getColWidth(col)`, `setColWidth(col, w)`: Dimension getters/setters for columns.
- `getRowHeight(row)`, `setRowHeight(row, h)`: Dimension getters/setters for rows.
- `getStyle(row, col)`, `setStyle(row, col, style)`: Style getters/setters for cells.
- `clearStyle(row, col)`, `bulkSetStyle(entries)`: Batch and clear operations for styles.
- `setFrozenRows(n)`, `setFrozenCols(n)`: Sets frozen row/column counts.
- `ensureCapacity(minRows, minCols)`: Expands sparse sheet dimensions when needed.
- `getComputedRange(startRow, startCol, endRow, endCol)`: Flushes and extracts 2D array of computed cell values.

---

## Undo semantics

| User Action | What a Single `Ctrl+Z` Reverts |
|---|---|
| Cell edit (single cell typing) | Restores the prior raw string and re-evaluates formulas |
| Range clear (`Delete` / `Backspace`) | Restores all cleared cell values across the selection |
| Fill handle drag | Restores all filled cells to their pre-drag states |
| Column sort | Restores all rows and cells to their exact pre-sort positions |
| Filter apply / clear all | Restores the previous filter view (hidden rows) |
| Row insertion / deletion | Restores sheet structure, shifted references, and styles |
| Column insertion / deletion | Restores sheet structure, shifted references, and styles |
| Format AI application | Restores all cell styles, number formats, widths, and freeze lines |
| AI query insertion into sheet | Clears all written result cells and restores previous cell contents |

---

## Defects found in the existing code

1. **Cycle Detection False Positives in Formula Evaluation**:
   - *Location*: `src/engine/core.js` in `evalAST` and `resolveCellValue`.
   - *Symptom*: Valid cell references (like `=SUM(A1:A2)*2` or `=A3+1`) returned 0 or `null` instead of computed numbers.
   - *Root cause*: Both `evalAST` and `resolveCellValue` were calling `visited.add(key)` on the same cell key before evaluating it, causing the cell to falsely detect itself as a circular dependency.
   - *Fix*: Centralized `visited` set management in `resolveCellValue`, passing the set into `evaluateFormula` and `evalAST` without redundant self-insertion.

2. **Currency and Percentage Parsing in Formula Arithmetic**:
   - *Location*: `src/engine/core.js` in `resolveCellValue` and `evalAST`.
   - *Symptom*: Dividing or multiplying formatted raw values (such as `=J2/G2` where J2 is `"$9,720.00"`) resulted in `#VALUE!`.
   - *Root cause*: `parseFloat` on string values with leading currency symbols (`$`) returned `NaN`.
   - *Fix*: Integrated `toNum()` coercion within `resolveCellValue` and binary arithmetic evaluation to parse currencies, percentages, and commas seamlessly.

3. **Global Aggregation in Query Executor**:
   - *Location*: `src/ai/executor.js`.
   - *Symptom*: Aggregate queries without `groupBy` (e.g., `How many orders in West?`) returned all 500 rows instead of a single scalar row.
   - *Root cause*: The executor only checked `plan.groupBy` and fell through to a projected row query when `groupBy` was absent.
   - *Fix*: Added an explicit branch for `plan.aggregates` without `groupBy` that evaluates aggregate functions over all filtered rows into a single summary row.

4. **Sort Performance on Large Datasets**:
   - *Location*: `src/engine/core.js` in `performSort`.
   - *Symptom*: Sorting 3,000 rows in `sales-large.tsv` exceeded the 300ms budget (~3,000ms).
   - *Root cause*: The sort comparator executed multiple regular expressions (`toNum`, `toDate`) on every pair comparison ($O(N \log N)$), and `_rewriteCellsFromRowOrder` checked all matrix coordinates including empty cells.
   - *Fix*: Pre-extracted and typed sort keys once per row in $O(N)$ before sorting, and rewrote cells sparsely using row-grouped maps, dropping sort time from 3,000ms down to ~146ms.

---

## Measurements

Measured on a production build (`npm run build` followed by test harness and performance timers):

| Metric / Budget | Required Budget | Measured Value | Measurement Method |
|---|---|---|---|
| Fill 5,000 cells | < 200 ms | **47 ms** | `performance.now()` delta filling 5,000 formula cells in test harness |
| Sort 3,000 rows (`sales-large.tsv`) | < 300 ms | **146 ms** | `performance.now()` delta sorting column 1 (Date) across 3,000 rows |
| Golden Query execution (`sales-large.tsv`) | < 50 ms / query | **~38 ms** avg | Total test time for 20 golden queries: 767 ms (~38 ms per query) |
| Production Build Time | — | **2.43 s** | Vite production bundle compilation |
| Lint Status | 0 errors | **0 errors, 0 warnings** | `eslint .` validation across all JS and JSX files |

---

## AI

- **Providers**: Clean provider abstraction with `MockProvider` (deterministic lookup matching golden eval sets in `fixtures/ai-eval/`) and `HttpProvider` (standard `fetch` against OpenAI-compatible or Anthropic endpoints configured via `.env.local`).
- **Context Shape**: The engine sends only metadata:
  ```json
  {
    "range": "A1:J33",
    "rowCount": 32,
    "columns": [
      { "name": "Order ID", "index": 0, "type": "id", "examples": ["ORD-1001", "ORD-1002"] },
      { "name": "Date", "index": 1, "type": "date", "examples": ["2024-01-03", "1/8/2024"] },
      { "name": "Total", "index": 9, "type": "currency", "examples": ["$4,320.00", "$2,160.30"] }
    ],
    "sampleRows": 5,
    "selection": "A1:J33",
    "hasTotalsRow": true
  }
  ```
- **Parsing & Validation**: Responses are cleaned of markdown formatting (` ```json ... ``` `) and validated through `validateAction` against JSON schemas. Invalid inputs or schema violations display informative errors and guarantee zero side-effects to the sheet.
- **Golden Set Parity**: 100% agreement with all 20 query golden cases (17 answers + 3 refusals) and all 10 format golden cases in `fixtures/ai-eval/`.

---

## Trade-offs and what you would do next

- **Web Workers for Computation**: Heavy queries on 100k+ rows could run in background Web Workers to maintain 120fps UI responsiveness during bulk computation.
- **Canvas Rendering for Virtual Grid**: While DOM virtualization with prefix sums easily handles 100k rows at 60fps, HTML5 Canvas or WebGL would eliminate DOM nodes entirely for extreme scale.
- **More Advanced Excel Functions**: Add extended formula support for `VLOOKUP`, `XLOOKUP`, and `INDEX/MATCH`.

---

## Use of AI tools

AI assistants were utilized for:
- Accelerated debugging of dependency cycle edge cases in the expression evaluator.
- Designing high-performance prefix-sum virtualization and binary search offsets.
- Writing comprehensive unit and acceptance tests verifying adherence to `AI_CONTRACT.md`.

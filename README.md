# SpreadsheetApp

A small browser spreadsheet built with React and Vite: a sparse cell engine with formulas, dependency tracking and undo, and a single-file grid UI.

**Candidates: the tasks are in [`CHALLENGE.md`](./CHALLENGE.md).** The AI tasks are specified in [`AI_CONTRACT.md`](./AI_CONTRACT.md). Write up your work in [`DESIGN_NOTES.md`](./DESIGN_NOTES.md).

## Prerequisites

- Node.js 18 or newer
- npm
- Git

## Getting started

```bash
git clone https://github.com/tauhidst07/spreadhsheet.git
cd spreadhsheet
npm install
npm run dev
```

Open `http://localhost:5173`. The toolbar has two sample loaders: **⬇ Sample 33** loads `fixtures/sales.tsv` (33 rows) and **⬇ Sample 3k** loads `fixtures/sales-large.tsv` (about 3,000 rows) at `A1`. Loading a sample replaces the sheet (undoable).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run lint` | ESLint |
| `npm test` | Run the Vitest suite once (`npm run test:watch` to keep it running) |
| `npm run perf` | Measure the performance budgets against `npm run preview` on port 4173 (needs Google Chrome) |

For the AI tasks, copy `.env.example` to `.env.local` and fill in the `VITE_AI_*` values for whichever LLM API you choose. The default provider is an offline mock, so the app runs without any key. A backend is optional; if you add one, it lives in `server/` and starts with `npm run server`.

## Project structure

```
spreadhsheet/
├── src/
│   ├── engine/                # Pure spreadsheet logic, no React
│   │   ├── core.js            # createEngine: cells, ids, undo, fill, sort, filters, styles, sizes
│   │   ├── formula.js         # Parser, evaluator, serializer; references stored by row/column id
│   │   ├── fill.js            # Fill-handle series inference
│   │   ├── values.js          # toNum / toDate / norm, number-format display
│   │   ├── layout.js          # Prefix sums + binary search for the virtualized grid
│   │   └── *.test.js
│   ├── ai/                    # Pure AI pipeline, no React
│   │   ├── contract.js        # Action schemas (given)
│   │   ├── validate.js        # JSON extraction + hand-written schema validator
│   │   ├── executor.js        # query plan executor
│   │   ├── formatApplier.js   # format_sheet planner + one-step applier
│   │   ├── sheet.js           # Table snapshot and the context sent to the model
│   │   ├── prompt.js, assistant.js, describe.js
│   │   ├── provider.js        # mock + http (plain fetch)
│   │   └── ai.test.js         # Both golden sets end to end
│   ├── grid/                  # Grid.jsx (virtualized), FilterMenu.jsx, selection/edit helpers
│   ├── ui/                    # AiPanel.jsx, perf counters
│   ├── fixtures/loadSample.js # The two "Sample" toolbar actions
│   └── App.jsx                # Toolbar, name box, formula bar, status bar
├── scripts/perf.mjs           # Production-build measurements
├── fixtures/                  # Sample data and AI golden sets
├── CHALLENGE.md / AI_CONTRACT.md
└── DESIGN_NOTES.md            # Design write-up and measurements
```

## What works

- 100,000 × 200 virtualized grid with frozen first row/column, resizable columns and rows (double-click a column border to auto-fit), name box (`AZ5000`, `K2:K100000`), formula bar.
- Selection: click, drag, Shift+click, Shift+arrows, row/column headers, `Ctrl+A` (used range). Editing: double-click, `Enter`, `F2` or just type. `Delete` clears the selection. `Ctrl+D` / `Ctrl+R` fill down / right, `Ctrl+C` / `Ctrl+V` copy and paste TSV.
- Fill handle: series of numbers, `Item 1`, `Q4`, `2024-W01`, dates in each seed's format, weekday and month names, formulas with relative/absolute references.
- Sort (header `⇅`: ascending → descending → original) and filters (header `▾`: values, search, conditions) with formulas following moved rows.
- Formulas: `+ - * / ^`, unary minus, brackets, `$` references, `SUM AVG AVERAGE MIN MAX COUNT` over ranges and values; `$1,200` and `10%` coerce in arithmetic. `#CYCLE!`, `#VALUE!`, `#REF!`, `#PARSE!`.
- Styles and number formats (`number`, `currency`, `percent`, `date`) per cell, moving with rows and columns.
- Every action, including fill, sort, filter, AI apply and insert, is one undo step (`Ctrl+Z`, `Ctrl+Shift+Z` / `Ctrl+Y`).
- `Ctrl+K`: ask questions about the data or ask for formatting (mock provider by default).

## Browser support

Current Chrome, Firefox, Safari and Edge.

## Troubleshooting

- **Install fails:** `rm -rf node_modules package-lock.json && npm install`.
- **Port 5173 busy:** Vite picks the next free port, or run `npm run dev -- --port 3000`.
- **Build fails:** make sure `npm install` completed, then `rm -rf dist && npm run build`.

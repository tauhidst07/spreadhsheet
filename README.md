# SpreadsheetApp

A browser spreadsheet built with React and Vite: a pure sparse engine (formulas, dependency graph, patch-based undo, sort, filter, styles), an imperative virtual grid for 100,000 × 200 cells, and an AI panel that turns questions and formatting requests into validated JSON plans that the engine executes.

The tasks are in [`CHALLENGE.md`](./CHALLENGE.md), the AI semantics in [`AI_CONTRACT.md`](./AI_CONTRACT.md), and the design write-up, engine API, undo semantics and measurements in [`DESIGN_NOTES.md`](./DESIGN_NOTES.md).

## Prerequisites

- Node.js 18 or newer (20 used for development), npm, Git
- For `npm run measure` only: Google Chrome at `/usr/bin/google-chrome` (or set `CHROME_PATH`)

## Run it

```bash
npm install
npm run dev            # http://localhost:5173 with hot reload
```

Production build:

```bash
npm run build          # dist/
npm run preview        # http://localhost:4173 (includes the AI relay)
# or: npm run server   # serves dist/ and the AI relay with plain Node on port 4173
```

## AI provider (`.env.local`)

The app runs offline with a deterministic mock that answers every prompt in `fixtures/ai-eval/`. To use a live model, copy the example and fill it in (any OpenAI-compatible chat-completions endpoint):

```bash
cp .env.example .env.local
```

```ini
AI_PROVIDER=http                     # mock | http
AI_ENDPOINT=https://api.example.com/v1/chat/completions
AI_API_KEY=your-api-key-here
AI_MODEL=your-model-name
```

Tested with Groq: `AI_ENDPOINT=https://api.groq.com/openai/v1/chat/completions`, `AI_MODEL=openai/gpt-oss-120b`.

`.env.local` is git-ignored. The key is read only by the dev/preview/`npm run server` relay at `/api/ai/chat`; it is never compiled into the browser bundle. Without a key, or with `AI_PROVIDER=mock`, the mock is used (the panel header says which). Restart `npm run dev` after editing `.env.local`.

## Load the fixtures

Toolbar **Sample 33** loads `fixtures/sales.tsv` (33 rows) and **Sample 3k** loads `fixtures/sales-large.tsv` (2,992 rows) at A1. The empty-sheet card offers the same two buttons.

## Fill K2 down to row 100,000

1. Load **Sample 3k**.
2. Click the name box (top left), type `K2`, Enter, type `=J2*2`, Enter.
3. Click the name box, type `K2:K100000`, Enter.
4. Press **Ctrl+D**. A progress badge shows while the fill runs in slices; one Ctrl+Z undoes it.

(Dragging the fill handle at the bottom-right corner of a selection works too.)

## Keyboard

| Keys | Action |
|---|---|
| Arrows, Shift+Arrows, Ctrl+Arrows | move, extend, jump to the data edge |
| Enter / F2 / typing, double-click | edit; Enter/Tab commit and move, Esc cancels |
| Ctrl+Home, Ctrl+End, PageUp/PageDown | first cell, last used cell, page |
| Ctrl+A | select the used range |
| Delete / Backspace | clear the selection (one undo) |
| Ctrl+D / Ctrl+R | fill down / right from the first row / column of the selection |
| Ctrl+B / I / U | bold / italic / underline the selection |
| Ctrl+Z, Ctrl+Y (Ctrl+Shift+Z) | undo, redo |
| Ctrl+K | open the AI panel |

Column headers: click to select the column, ⇅ to sort (asc → desc → original), ▾ for the filter menu, drag the right edge to resize, double-click it to auto-fit. Row headers: click to select, drag the bottom edge to change the height, double-click it to reset.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build (with the AI relay) |
| `npm run server` | Optional Node server for `dist/` plus the AI relay |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm test` | Vitest unit tests for the engine |
| `npm run verify` | `node scripts/verify.mjs`: every acceptance check, both golden sets, error paths, purity, Node-side budgets |
| `npm run measure` | `node scripts/measure.mjs`: builds `dist-measure/`, serves it with `vite preview` and measures first paint, scrolling, typing latency, React commits and long tasks in headless Chrome |

## Project structure

```
src/
├── engine/          # pure: values.js (coercion, number formats), formula.js (parser, templates),
│                    #       fill.js (series), core.js (engine), core.test.js
├── ai/              # contract.js, runtime.js (parse/validate/context/executor), format.js (applier),
│                    # provider.js, mockProvider.js, AiPanel.jsx (lazy-loaded Ctrl+K panel)
├── grid/            # GridView.js (imperative virtual grid), FilterMenu.jsx
├── fixtures/        # loadSample.js (fixtures loaded on demand)
├── App.jsx, Toolbar.jsx, App.css, index.css, main.jsx
server/              # aiRelay.js (same-origin relay), index.mjs (optional production server)
scripts/             # verify.mjs, measure.mjs
fixtures/            # sales.tsv, sales-large.tsv, ai-eval/
```

## Troubleshooting

- **Install fails:** `rm -rf node_modules package-lock.json && npm install`.
- **Port busy:** `npm run dev -- --port 3000`.
- **Live model not used:** check that `.env.local` has `AI_PROVIDER=http` and a key, then restart the server.

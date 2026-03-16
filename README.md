Task 1 — Sort & Filter
Every column header has two controls:

Click the column letter (e.g. "A") to cycle sort: first click = A→Z ascending, second click = Z→A descending, third click = off. A ↑ or ↓ icon shows the active state
Click the ▾ button next to the letter to open a filter dropdown. It shows every unique value in that column with checkboxes — uncheck values to hide those rows. The rows aren't deleted, just hidden. Formulas still calculate against original cell positions

Task 2 — Copy & Paste

Ctrl+C on a selected cell copies the computed value (so if A1 has =1+1, it copies 2) to your clipboard. The cell gets a dashed blue border
Ctrl+V pastes whatever is in your clipboard starting at the selected cell. If you copy a range from Excel or Google Sheets, it pastes the whole grid because they use tab-separated format which parseTSV handles
Ctrl+Z undoes the entire paste in one step (not cell by cell)
Ctrl+Y redoes it

Task 3 — localStorage

Every time you change a cell or style, it auto-saves after 500ms silently in the background
If you close the tab and reopen it, all your data and styles come back exactly as you left them
Undo/redo history does not restore (fresh stack on each page load)
Clicking ✕ All clears both the grid and the saved data

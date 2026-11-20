# Queryspace local SQL workspace

Queryspace now runs as a local SQLite-backed SQL workspace. Imported CSV and modern Excel workbooks are stored in `.queryspace-data/queryspace.sqlite3` beside the project and remain there between visits and server restarts. The server listens on `127.0.0.1` only; it is not exposed to your network.

## Start it

1. In File Explorer, open this project folder and double-click `start_queryspace.bat`.
2. Keep the black command window open while using the database; it runs the local SQLite API on port 5502.
3. Open <http://127.0.0.1:5502/index.html>, or use Live Server at <http://127.0.0.1:5501/index.html> while the Queryspace service is running. The **Sign in** and demo buttons open `database.html` on the same page port; its API requests are routed to the backend on port 5502.

Live Server serves the interface files only, so the Queryspace service must stay running for imports and SQL. The separate Space Lab preview on port 5500 is not changed.

## Import and query

- Choose **Import data**, select a `.csv`, `.tsv`, `.xlsx`, or `.xlsm` file, review the preview and table name, then import.
- Excel workbooks show a worksheet picker. Column headings are converted to safe SQLite column names; duplicate/blank headings are made unique.
- The database studio's **Diagram** view shows live table cards, columns, row counts and known/matching key relationships. Click a card's query action to open its starter `SELECT` in SQL workspace.
- Select **Query this table** in the table explorer to write a starter `SELECT` query. Edit it and choose **Run SQL**, or press Ctrl+Enter.
- Save useful SQL in **Saved queries**. Download query results as CSV with **Export CSV**.
- Sample `customers` and `orders` tables and two saved example queries are created automatically if they are missing.

This local build supports `.xlsx` and `.xlsm` Excel workbooks; the older binary `.xls` format must be saved as `.xlsx` first. CSV/Excel imports are limited to 24 MB per file, and displayed SQL results are capped at 500 rows (the full imported table remains in SQLite).

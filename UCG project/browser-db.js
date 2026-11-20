/* Queryspace's static-hosted SQLite demo. All SQL and imported files stay in this browser. */
(() => {
  'use strict';
  const params = new URLSearchParams(window.location.search);
  const githubPages = window.location.hostname === 'github.io' || window.location.hostname.endsWith('.github.io');
  const enabled = githubPages || params.get('demo') === '1' || params.get('demo') === 'true';
  if (!enabled) {
    window.QueryspaceBrowserDB = { enabled: false };
    return;
  }

  const scriptUrl = document.currentScript?.src || new URL('browser-db.js', document.baseURI).href;
  const vendorUrl = new URL('vendor/', scriptUrl);
  const databaseName = 'queryspace-browser-sqlite-v1';
  const storageKey = 'main';
  const maxUploadBytes = 24 * 1024 * 1024;
  const maxRowsOut = 500;
  let db;
  let readyPromise;
  let xlsxPromise;
  let idbPromise;

  const quoteIdent = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const safeName = (value) => {
    let cleaned = String(value || '').trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || 'imported_table';
    if (/^\d/.test(cleaned)) cleaned = `table_${cleaned}`;
    return cleaned.slice(0, 80);
  };
  const now = () => new Date().toISOString();

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      const existing = [...document.scripts].find((item) => item.src === url);
      if (existing?.dataset.loaded === 'true') return resolve();
      if (existing) {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', () => reject(new Error('A required browser SQL library could not be loaded.')), { once: true });
        return;
      }
      const script = document.createElement('script');
      script.src = url;
      script.async = true;
      script.onload = () => { script.dataset.loaded = 'true'; resolve(); };
      script.onerror = () => reject(new Error('A required browser SQL library could not be loaded.'));
      document.head.append(script);
    });
  }

  function openStorage() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser does not offer local database storage. Try a current version of Chrome, Edge, Firefox, or Safari.'));
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('databases');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Browser-local storage could not be opened. Check private-browsing or storage settings.'));
      request.onblocked = () => reject(new Error('Close another Queryspace demo tab to initialize browser-local storage.'));
    });
    return idbPromise;
  }

  async function storageGet(key) {
    const storeDb = await openStorage();
    return new Promise((resolve, reject) => {
      const request = storeDb.transaction('databases', 'readonly').objectStore('databases').get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error('Could not read this browser’s saved database.'));
    });
  }

  async function storagePut(key, value) {
    const storeDb = await openStorage();
    return new Promise((resolve, reject) => {
      const transaction = storeDb.transaction('databases', 'readwrite');
      transaction.objectStore('databases').put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('The browser could not save this database. Free up browser storage and try again.'));
      transaction.onabort = () => reject(new Error('The browser stopped saving this database. Free up browser storage and try again.'));
    });
  }

  async function persist() {
    try { await storagePut(storageKey, db.export()); }
    catch (error) {
      const message = /save this database/i.test(error.message) ? error.message : 'The browser could not persist the database locally. Check available browser storage.';
      throw new Error(message);
    }
  }

  function tableExists(name) {
    const statement = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=? AND name NOT LIKE 'sqlite_%'");
    try { statement.bind([name]); return statement.step(); }
    finally { statement.free(); }
  }

  function seedDatabase() {
    db.run('PRAGMA foreign_keys=ON');
    db.run('CREATE TABLE IF NOT EXISTS "_qs_imports" (table_name TEXT PRIMARY KEY, source_file TEXT NOT NULL, worksheet TEXT, imported_at TEXT NOT NULL, row_count INTEGER NOT NULL)');
    db.run('CREATE TABLE IF NOT EXISTS "_qs_saved_queries" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sql TEXT NOT NULL, updated_at TEXT NOT NULL)');
    if (!tableExists('customers')) {
      db.run('CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, customer_name TEXT NOT NULL, plan TEXT NOT NULL, monthly_spend REAL NOT NULL, status TEXT NOT NULL, city TEXT NOT NULL)');
      db.run('INSERT INTO customers VALUES (1,\'Atlas Studio\',\'Growth\',4280,\'active\',\'Austin\'),(2,\'Northstar Labs\',\'Scale\',3840,\'active\',\'Seattle\'),(3,\'Common Ground\',\'Growth\',2760,\'active\',\'Denver\'),(4,\'Paper Plane Co.\',\'Starter\',1920,\'active\',\'Brooklyn\'),(5,\'Sunroom Health\',\'Growth\',1640,\'active\',\'Portland\'),(6,\'Signal & Soil\',\'Starter\',920,\'paused\',\'Chicago\')');
    }
    if (!tableExists('orders')) {
      db.run('CREATE TABLE orders (order_id INTEGER PRIMARY KEY, order_date TEXT NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(customer_id), total REAL NOT NULL, status TEXT NOT NULL)');
      db.run('INSERT INTO orders VALUES (1001,\'2026-11-16\',1,1290,\'paid\'),(1002,\'2026-11-15\',2,840,\'paid\'),(1003,\'2026-11-14\',3,420,\'paid\'),(1004,\'2026-11-13\',1,1620,\'paid\'),(1005,\'2026-11-12\',4,280,\'pending\'),(1006,\'2026-11-11\',5,960,\'paid\'),(1007,\'2026-11-10\',2,740,\'paid\'),(1008,\'2026-11-09\',3,540,\'refunded\')');
    }
    const savedCount = db.exec('SELECT COUNT(*) FROM "_qs_saved_queries"')[0]?.values?.[0]?.[0] || 0;
    if (!savedCount) {
      const insert = db.prepare('INSERT INTO "_qs_saved_queries" (name,sql,updated_at) VALUES (?,?,?)');
      try {
        insert.run(['Active customers', "SELECT customer_name, plan, monthly_spend, city\nFROM customers\nWHERE status = 'active'\nORDER BY monthly_spend DESC;", now()]);
        insert.run(['Recent orders', 'SELECT order_id, order_date, customer_id, total, status\nFROM orders\nORDER BY order_date DESC\nLIMIT 10;', now()]);
      } finally { insert.free(); }
    }
  }

  async function initialize() {
    await loadScript(new URL('sql-wasm.js', vendorUrl).href);
    if (typeof window.initSqlJs !== 'function') throw new Error('The browser SQLite engine did not initialize. Reload the page and try again.');
    const SQL = await window.initSqlJs({ locateFile: (file) => new URL(file, vendorUrl).href });
    const saved = await storageGet(storageKey);
    db = saved ? new SQL.Database(new Uint8Array(saved)) : new SQL.Database();
    seedDatabase();
    if (!saved) await persist();
    else {
      // Keep metadata tables available for databases saved by an earlier demo build.
      await persist();
    }
  }

  function ensureReady() {
    if (!readyPromise) readyPromise = initialize();
    return readyPromise;
  }

  function rowsFor(sql, params = []) {
    const statement = db.prepare(sql);
    try {
      if (params.length) statement.bind(params);
      const columns = statement.getColumnNames();
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return { columns, rows };
    } finally { statement.free(); }
  }

  function countRows(name) {
    const result = rowsFor(`SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`);
    return Number(result.rows[0]?.n || 0);
  }

  function tableInfo(name) {
    const info = rowsFor(`PRAGMA table_info(${quoteIdent(name)})`).rows;
    const columns = info.map((row) => ({ name: row.name, type: row.type || 'TEXT', notnull: Boolean(row.notnull), primary: Boolean(row.pk) }));
    const sourceRows = rowsFor('SELECT source_file, worksheet, imported_at FROM "_qs_imports" WHERE table_name=?', [name]).rows;
    return { name, columns, row_count: countRows(name), source: sourceRows[0] || null };
  }

  function allTables() {
    return rowsFor("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_qs_%' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE").rows.map((row) => row.name);
  }

  function relationships(names) {
    const included = new Set(names.map((name) => name.toLocaleLowerCase()));
    const infos = new Map(names.map((name) => [name, rowsFor(`PRAGMA table_info(${quoteIdent(name)})`).rows]));
    const edges = [];
    const seen = new Set();
    const add = (source, sourceColumn, target, targetColumn, method) => {
      if (source.toLocaleLowerCase() === target.toLocaleLowerCase() || !included.has(target.toLocaleLowerCase())) return;
      const key = [source, sourceColumn, target, targetColumn].map((part) => String(part).toLocaleLowerCase()).join('|');
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({ from_table: source, from_column: sourceColumn, to_table: target, to_column: targetColumn, method });
    };
    for (const source of names) {
      for (const foreign of rowsFor(`PRAGMA foreign_key_list(${quoteIdent(source)})`).rows) {
        const target = foreign.table;
        if (!infos.has(target)) continue;
        const targetColumn = foreign.to || infos.get(target).find((column) => column.pk)?.name || foreign.from;
        add(source, foreign.from, target, targetColumn, 'foreign key');
      }
    }
    const primaryByName = new Map();
    for (const [target, columns] of infos) for (const column of columns) if (column.pk) {
      const key = column.name.toLocaleLowerCase();
      if (!primaryByName.has(key)) primaryByName.set(key, []);
      primaryByName.get(key).push([target, column.name]);
    }
    for (const [source, columns] of infos) for (const column of columns) {
      if (column.pk || !String(column.name).toLocaleLowerCase().endsWith('_id')) continue;
      const candidates = (primaryByName.get(column.name.toLocaleLowerCase()) || []).filter(([target]) => target.toLocaleLowerCase() !== source.toLocaleLowerCase());
      if (candidates.length === 1) add(source, column.name, candidates[0][0], candidates[0][1], 'matching key');
    }
    return edges.sort((a, b) => `${a.from_table}|${a.from_column}|${a.to_table}`.localeCompare(`${b.from_table}|${b.from_column}|${b.to_table}`));
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"' && cell === '') quoted = true;
      else if (char === delimiter) { row.push(cell.trim()); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        row.push(cell.trim());
        if (row.some((value) => value !== '')) rows.push(row);
        row = []; cell = '';
      } else cell += char;
    }
    row.push(cell.trim());
    if (row.some((value) => value !== '')) rows.push(row);
    return rows;
  }

  function detectDelimiter(text) {
    const first = text.split(/[\r\n]/, 1)[0] || '';
    let best = ',', bestCount = -1;
    for (const candidate of [',', '\t', ';', '|']) {
      let count = 0, quoted = false;
      for (let index = 0; index < first.length; index += 1) {
        if (first[index] === '"') {
          if (quoted && first[index + 1] === '"') index += 1;
          else quoted = !quoted;
        } else if (!quoted && first[index] === candidate) count += 1;
      }
      if (count > bestCount) { best = candidate; bestCount = count; }
    }
    return best;
  }

  function normalizeHeaders(rawHeaders) {
    const used = new Set();
    return rawHeaders.map((raw, index) => {
      let base = String(raw ?? '').trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '') || `column_${index + 1}`;
      if (/^\d/.test(base)) base = `column_${base}`;
      let candidate = base.slice(0, 80), suffix = 2;
      while (used.has(candidate.toLocaleLowerCase())) { candidate = `${base.slice(0, 72)}_${suffix++}`; }
      used.add(candidate.toLocaleLowerCase());
      return candidate;
    });
  }

  function rowsToPreview(rawRows, format, sheets = [], sheet = null) {
    const nonempty = rawRows.filter((row) => row.some((value) => value !== null && value !== undefined && String(value).trim() !== ''));
    if (nonempty.length < 2) throw new Error('The file needs a header row and at least one data row.');
    const headers = normalizeHeaders(nonempty[0]);
    const rows = nonempty.slice(1).map((row) => headers.map((_, index) => row[index] === undefined || row[index] === '' ? null : row[index]));
    return { format, sheets, sheet, headers, rows, count: rows.length };
  }

  function getXlsx() {
    if (!xlsxPromise) xlsxPromise = loadScript(new URL('xlsx.full.min.js', vendorUrl).href).then(() => {
      if (!window.XLSX) throw new Error('The Excel workbook reader did not initialize.');
      return window.XLSX;
    });
    return xlsxPromise;
  }

  function bytesFromBase64(encoded) {
    let binary;
    try { binary = atob(encoded || ''); }
    catch { throw new Error('The uploaded file could not be decoded.'); }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function inspectFile(filename, encoded, selectedSheet) {
    const bytes = bytesFromBase64(encoded);
    if (bytes.byteLength > maxUploadBytes) throw new Error('Files must be 24 MB or smaller.');
    const extension = String(filename).split('.').pop().toLocaleLowerCase();
    if (['csv', 'tsv', 'txt'].includes(extension)) {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('windows-1252').decode(bytes); }
      const rawRows = parseDelimited(text.replace(/^\uFEFF/, ''), extension === 'tsv' ? '\t' : detectDelimiter(text));
      return rowsToPreview(rawRows, 'csv');
    }
    if (['xlsx', 'xlsm', 'xls'].includes(extension)) {
      const XLSX = await getXlsx();
      let workbook;
      try { workbook = XLSX.read(bytes, { type: 'array', cellDates: true }); }
      catch { throw new Error('This Excel workbook could not be read.'); }
      const sheets = workbook.SheetNames || [];
      if (!sheets.length) throw new Error('No readable worksheet was found in this workbook.');
      const sheet = sheets.includes(selectedSheet) ? selectedSheet : sheets[0];
      const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { header: 1, raw: true, defval: null, blankrows: false });
      return rowsToPreview(rawRows, 'excel', sheets, sheet);
    }
    throw new Error('Choose a CSV, TSV, .xlsx, or .xlsm file.');
  }

  function inferType(values) {
    const present = values.filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
    if (!present.length) return 'TEXT';
    if (present.every((value) => typeof value === 'boolean' || Number.isInteger(value))) return 'INTEGER';
    if (present.every((value) => typeof value === 'number' && Number.isFinite(value))) return 'REAL';
    const strings = present.map((value) => value instanceof Date ? value.toISOString() : String(value).trim());
    if (strings.every((value) => /^[+-]?\d+$/.test(value))) {
      const digits = strings.map((value) => value.replace(/^[+-]/, ''));
      return digits.every((value) => value === '0' || !value.startsWith('0')) && digits.every((value) => value.length < 16) ? 'INTEGER' : 'TEXT';
    }
    if (strings.every((value) => /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) return 'REAL';
    return 'TEXT';
  }

  function castValue(value, type) {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (type === 'INTEGER') {
      const number = Number(value);
      return Number.isFinite(number) ? Math.trunc(number) : String(value);
    }
    if (type === 'REAL') {
      const number = Number(value);
      return Number.isFinite(number) ? number : String(value);
    }
    return typeof value === 'object' ? JSON.stringify(value) : String(value).trim();
  }

  async function importTable(payload) {
    const filename = String(payload.filename || 'upload.csv').split(/[\\/]/).pop();
    const preview = await inspectFile(filename, payload.data_base64, payload.worksheet);
    if (!preview.rows.length) throw new Error('This file has no data rows to import.');
    const table = safeName(payload.table_name || filename.replace(/\.[^.]+$/, ''));
    if (tableExists(table)) throw new Error(`Table "${table}" already exists. Choose another table name; existing data was not changed.`);
    const types = preview.headers.map((_, index) => inferType(preview.rows.map((row) => row[index])));
    const definition = preview.headers.map((header, index) => `${quoteIdent(header)} ${types[index]}`).join(', ');
    const insertSql = `INSERT INTO ${quoteIdent(table)} VALUES (${preview.headers.map(() => '?').join(',')})`;
    db.run('BEGIN');
    try {
      db.run(`CREATE TABLE ${quoteIdent(table)} (${definition})`);
      const insert = db.prepare(insertSql);
      try {
        for (const row of preview.rows) insert.run(row.map((value, index) => castValue(value, types[index])));
      } finally { insert.free(); }
      const meta = db.prepare('INSERT INTO "_qs_imports" (table_name,source_file,worksheet,imported_at,row_count) VALUES (?,?,?,?,?)');
      try { meta.run([table, filename, preview.sheet, now(), preview.rows.length]); }
      finally { meta.free(); }
      db.run('COMMIT');
    } catch (error) {
      try { db.run('ROLLBACK'); } catch { /* retain original import error */ }
      throw error;
    }
    await persist();
    return { ok: true, table, row_count: preview.rows.length, columns: preview.headers.map((name, index) => ({ name, type: types[index] })), worksheet: preview.sheet, source_file: filename };
  }

  function splitStatements(sql) {
    const statements = [];
    let start = 0, quote = '', lineComment = false, blockComment = false;
    for (let index = 0; index < sql.length; index += 1) {
      const char = sql[index], next = sql[index + 1];
      if (lineComment) { if (char === '\n') lineComment = false; continue; }
      if (blockComment) { if (char === '*' && next === '/') { blockComment = false; index += 1; } continue; }
      if (quote) {
        if ((quote === ']' && char === ']') || (quote !== ']' && char === quote)) {
          if (next === quote && quote !== ']') index += 1;
          else quote = '';
        }
        continue;
      }
      if (char === '-' && next === '-') { lineComment = true; index += 1; continue; }
      if (char === '/' && next === '*') { blockComment = true; index += 1; continue; }
      if (char === '\'' || char === '"' || char === '`') { quote = char; continue; }
      if (char === '[') { quote = ']'; continue; }
      if (char === ';') {
        const part = sql.slice(start, index).trim();
        if (part) statements.push(part);
        start = index + 1;
      }
    }
    const last = sql.slice(start).trim();
    if (last) statements.push(last);
    return statements;
  }

  async function runQuery(sql) {
    const statements = splitStatements(String(sql || '').trim());
    if (!statements.length) throw new Error('Enter a SQL statement first.');
    if (statements.length > 1) throw new Error('Run one SQL statement at a time.');
    const started = performance.now();
    let statement;
    try { statement = db.prepare(statements[0]); }
    catch (error) { throw new Error(error.message || 'This SQL statement could not be prepared.'); }
    const columns = statement.getColumnNames();
    const rows = [];
    let truncated = false;
    try {
      if (columns.length) {
        while (statement.step()) {
          if (rows.length === maxRowsOut) { truncated = true; break; }
          rows.push(statement.get());
        }
      } else {
        while (statement.step()) { /* execute statements with no result columns */ }
      }
    } finally { statement.free(); }
    await persist();
    const elapsed = Math.round((performance.now() - started) * 10) / 10;
    const message = columns.length
      ? `Returned ${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ' (display capped at 500).' : ''}`
      : `Statement completed successfully. ${db.getRowsModified()} row${db.getRowsModified() === 1 ? '' : 's'} changed.`;
    return { ok: true, columns, rows, row_count: rows.length, truncated, elapsed_ms: elapsed, message };
  }

  function getTable(name) {
    if (!allTables().some((item) => item === name)) throw new Error('That table was not found.');
    const table = tableInfo(name);
    const statement = db.prepare(`SELECT * FROM ${quoteIdent(name)} LIMIT 100`);
    const rows = [];
    try { while (statement.step()) rows.push(statement.getAsObject()); }
    finally { statement.free(); }
    return { table, columns: table.columns.map((column) => column.name), rows };
  }

  async function route(path, options) {
    const url = new URL(path, window.location.href);
    const routePath = url.pathname;
    const method = String(options.method || 'GET').toUpperCase();
    let payload = {};
    if (options.body) {
      try { payload = typeof options.body === 'string' ? JSON.parse(options.body) : options.body; }
      catch { throw new Error('Request body must be valid JSON.'); }
    }
    if (routePath === '/api/status' && method === 'GET') {
      return { ok: true, engine: 'SQLite in this browser', database: 'Browser-local database', table_count: allTables().length };
    }
    if (routePath === '/api/tables' && method === 'GET') {
      const names = allTables();
      return { tables: names.map(tableInfo), relationships: relationships(names) };
    }
    if (routePath === '/api/table' && method === 'GET') return getTable(url.searchParams.get('name') || '');
    if (routePath === '/api/queries' && method === 'GET') {
      return { queries: rowsFor('SELECT id,name,sql,updated_at FROM "_qs_saved_queries" ORDER BY updated_at DESC,id DESC').rows };
    }
    if (routePath === '/api/inspect' && method === 'POST') {
      const preview = await inspectFile(payload.filename, payload.data_base64, payload.worksheet);
      return { format: preview.format, sheets: preview.sheets, sheet: preview.sheet, headers: preview.headers, sample_rows: preview.rows.slice(0, 5), row_count: preview.count };
    }
    if (routePath === '/api/import' && method === 'POST') return importTable(payload);
    if (routePath === '/api/query' && method === 'POST') return runQuery(payload.sql);
    if (routePath === '/api/queries' && method === 'POST') {
      const name = String(payload.name || '').trim().slice(0, 100);
      const sql = String(payload.sql || '').trim();
      if (!name) throw new Error('Give this saved query a name.');
      if (!sql) throw new Error('There is no SQL to save.');
      const statement = db.prepare('INSERT INTO "_qs_saved_queries" (name,sql,updated_at) VALUES (?,?,?)');
      try { statement.run([name, sql, now()]); }
      finally { statement.free(); }
      await persist();
      const saved = rowsFor('SELECT id,name,sql,updated_at FROM "_qs_saved_queries" WHERE id=last_insert_rowid()').rows[0];
      return { ok: true, query: saved };
    }
    const deleteMatch = routePath.match(/^\/api\/queries\/(\d+)$/);
    if (deleteMatch && method === 'DELETE') {
      const statement = db.prepare('DELETE FROM "_qs_saved_queries" WHERE id=?');
      try { statement.run([Number(deleteMatch[1])]); }
      finally { statement.free(); }
      if (!db.getRowsModified()) throw new Error('Saved query not found.');
      await persist();
      return { ok: true, deleted_id: Number(deleteMatch[1]) };
    }
    throw new Error(`Unknown browser demo route: ${method} ${routePath}`);
  }

  function applyBrowserLabels() {
    const setText = (selector, value) => { const element = document.querySelector(selector); if (element) element.textContent = value; };
    setText('.db-top-location .db-breadcrumb-muted', 'BROWSER DATABASE');
    setText('.db-top-location strong', 'Browser-local SQLite');
    setText('.ide-db-copy strong', 'Queryspace demo');
    setText('.ide-db-copy span', 'SQLite saved in this browser');
    const chip = document.querySelector('.db-local-chip');
    if (chip) { const icon = document.createElement('i'); chip.replaceChildren(icon, document.createTextNode(' BROWSER ONLY')); }
    const status = document.querySelector('.ide-statusbar span:first-child');
    if (status) { const indicator = status.querySelector('i') || document.createElement('i'); status.replaceChildren(indicator, document.createTextNode(' Browser-only SQLite · saved in this browser')); }
    const note = document.querySelector('.db-local-note');
    if (note) { const icon = note.querySelector('span[aria-hidden="true"]') || document.createElement('span'); icon.setAttribute('aria-hidden', 'true'); icon.textContent = '⌁'; note.replaceChildren(icon, document.createTextNode(' No account needed. Sample data and imports stay in this browser only; nothing is sent to a server. '), Object.assign(document.createElement('span'), { textContent: 'Press Ctrl+Enter to run SQL.' })); }
    const localNote = document.querySelector('.ide-local-note:not(.db-local-note)');
    if (localNote) localNote.textContent = 'This demo runs entirely in your browser. Sample data and imported files stay in this browser; they are never sent to a server. Press Ctrl+Enter to run SQL.';
    setText('#ide-save-dialog .ide-dialog-description', 'Your SQL query is saved only in this browser.');
  }
  applyBrowserLabels();

  window.QueryspaceBrowserDB = {
    enabled: true,
    storage: 'IndexedDB in this browser only',
    request: async (path, options = {}) => {
      await ensureReady();
      return route(path, options);
    }
  };
})();

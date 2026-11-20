(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const API_BASE = window.location.port === '5501' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)
    ? `http://${window.location.hostname}:5502`
    : window.location.origin;
  const apiUrl = (path) => new URL(path, API_BASE).toString();
  const ui = {
    query: $('#ide-query-input'), run: $('#ide-run-query'), runStatus: $('#ide-run-status'),
    lineNumbers: $('#ide-line-numbers'), head: $('#ide-result-head'), body: $('#ide-result-body'),
    empty: $('#ide-empty-state'), count: $('#ide-results-count'), summary: $('#ide-row-summary'),
    elapsed: $('#ide-elapsed'), export: $('#ide-export-results'), tableList: $('#ide-table-list'),
    tableCount: $('#ide-table-count'), savedList: $('#ide-saved-list'), tableSearch: $('#ide-table-search'),
    title: $('#ide-query-title'), statusDot: $('#ide-connection-dot'), dbName: $('#ide-db-name'),
    fileInput: $('#ide-file-input'), importDialog: $('#ide-import-dialog'), importForm: $('#ide-import-form'),
    importName: $('#ide-table-name'), importMeta: $('#ide-import-file-meta'), preview: $('#ide-import-preview'),
    worksheet: $('#ide-worksheet'), worksheetWrap: $('#ide-worksheet-wrap'), importMessage: $('#ide-import-message'),
    importConfirm: $('#ide-import-confirm'), saveDialog: $('#ide-save-dialog'), saveForm: $('#ide-save-form'),
    saveName: $('#ide-save-name'), saveMessage: $('#ide-save-message'), toast: $('#toast')
  };
  let tables = [];
  let queries = [];
  let currentTable = 'customers';
  let activeView = 'results';
  let lastResult = null;
  let currentQueryName = 'Untitled query';
  let pendingFile = null;
  let toastTimer;

  function toast(message) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.toast.classList.remove('is-visible'), 2600);
  }
  async function api(url, options = {}) {
    const response = await fetch(apiUrl(url), { cache: 'no-store', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    let data;
    try { data = await response.json(); } catch { throw new Error('The local SQL service did not return a response. Start start_queryspace.bat.'); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function setConnected(connected, detail) {
    ui.statusDot?.classList.toggle('is-offline', !connected);
    if (ui.statusDot) ui.statusDot.title = connected ? 'Connected to local SQLite' : 'Local database unavailable';
    const statusLight = document.querySelector('.ide-statusbar i');
    statusLight?.classList.toggle('is-offline', !connected);
    if (ui.dbName) ui.dbName.textContent = connected ? detail || 'queryspace.sqlite3' : 'Start start_queryspace.bat';
    if (!connected) ui.runStatus.textContent = 'Database offline · start the local SQL service';
  }
  function safeName(name) {
    return String(name || '').trim().replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'imported_table';
  }
  function quoteName(name) { return `"${String(name).replaceAll('"', '""')}"`; }
  function sqlFromTable(name) { return `SELECT *\nFROM ${quoteName(name)}\nLIMIT 100;`; }
  function refreshLineNumbers() {
    if (!ui.query || !ui.lineNumbers) return;
    const count = Math.max(1, ui.query.value.split('\n').length);
    ui.lineNumbers.textContent = Array.from({ length: count }, (_, i) => i + 1).join('\n');
  }
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function showData(columns, rows, { total = rows.length, truncated = false, emptyText = 'No rows were returned.', rowSummary, allowExport = true } = {}) {
    ui.head.replaceChildren();
    ui.body.replaceChildren();
    ui.count.textContent = String(total);
    ui.empty.hidden = columns.length > 0;
    ui.empty.textContent = emptyText;
    if (columns.length) {
      const header = el('tr');
      columns.forEach((name) => header.append(el('th', '', name)));
      ui.head.append(header);
      rows.forEach((row) => {
        const tr = el('tr');
        row.forEach((value) => {
          const td = el('td', '', value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : value);
          if (value === null) td.classList.add('is-null');
          td.title = td.textContent;
          tr.append(td);
        });
        ui.body.append(tr);
      });
    }
    ui.summary.textContent = rowSummary || (columns.length ? `Showing ${rows.length}${truncated ? '+' : ''} row${rows.length === 1 ? '' : 's'}${truncated ? ' · output capped at 500 rows' : ''}` : emptyText);
    ui.export.disabled = !allowExport || !columns.length;
  }
  function setRunStatus(text, isError = false) {
    ui.runStatus.textContent = text;
    ui.runStatus.classList.toggle('is-error', isError);
  }
  async function runQuery() {
    const sql = ui.query.value.trim();
    if (!sql) { setRunStatus('Write a SQL statement first.', true); ui.query.focus(); return; }
    ui.run.disabled = true;
    ui.run.innerHTML = '<span aria-hidden="true">◌</span> Running…';
    setRunStatus('Running against local SQLite…');
    ui.elapsed.textContent = '';
    const started = performance.now();
    try {
      const result = await api('/api/query', { method: 'POST', body: JSON.stringify({ sql }) });
      lastResult = result;
      activeView = 'results';
      document.querySelectorAll('[data-ide-view]').forEach((tab) => {
        const selected = tab.dataset.ideView === 'results';
        tab.classList.toggle('is-active', selected);
        tab.setAttribute('aria-selected', String(selected));
      });
      const hasRows = result.columns.length > 0;
      showData(result.columns, result.rows, {
        total: result.row_count,
        truncated: result.truncated,
        emptyText: result.message || 'Statement complete. No result rows to display.',
        rowSummary: hasRows ? `${result.row_count}${result.truncated ? '+' : ''} row${result.row_count === 1 ? '' : 's'} returned${result.truncated ? ' · showing first 500' : ''}` : result.message,
        allowExport: hasRows
      });
      setRunStatus(result.message);
      ui.elapsed.textContent = `${result.elapsed_ms ?? Math.round(performance.now() - started)} ms`;
      if (hasRows) lastResult = result;
      toast(hasRows ? `Query returned ${result.row_count}${result.truncated ? '+' : ''} rows.` : 'SQL statement completed.');
    } catch (error) {
      lastResult = null;
      showData([], [], { emptyText: error.message, rowSummary: 'Query needs attention', allowExport: false });
      setRunStatus(error.message, true);
      ui.elapsed.textContent = 'Error';
    } finally {
      ui.run.disabled = false;
      ui.run.innerHTML = '<span aria-hidden="true">▶</span> Run SQL <kbd>Ctrl ↵</kbd>';
    }
  }
  function renderTables() {
    const filter = ui.tableSearch.value.trim().toLocaleLowerCase();
    const visible = tables.filter((table) => table.name.toLocaleLowerCase().includes(filter));
    ui.tableCount.textContent = String(tables.length);
    ui.tableList.replaceChildren();
    if (!visible.length) {
      ui.tableList.append(el('p', 'ide-muted-message', filter ? 'No tables match that filter.' : 'No tables yet. Import a CSV or Excel file to add one.'));
      return;
    }
    visible.forEach((table) => {
      const details = el('details', 'ide-table-item');
      if (table.name === currentTable) details.open = true;
      const summary = el('summary', 'ide-table-summary');
      summary.append(el('span', 'ide-table-glyph', '▦'), el('span', 'ide-table-name', table.name), el('span', 'ide-table-rows', `${table.row_count} rows`));
      details.append(summary);
      const cols = el('div', 'ide-table-columns');
      const openButton = el('button', 'ide-open-table', '↗ Query this table');
      openButton.type = 'button';
      openButton.dataset.queryTable = table.name;
      cols.append(openButton);
      table.columns.forEach((column) => {
        const line = el('div', 'ide-column-line');
        line.append(el('span', '', `${column.primary ? '◆ ' : ''}${column.name}`), el('span', '', column.type));
        cols.append(line);
      });
      details.append(cols);
      ui.tableList.append(details);
    });
  }
  async function loadTables() {
    const data = await api('/api/tables');
    tables = data.tables || [];
    if (currentTable && !tables.some((table) => table.name === currentTable)) currentTable = tables[0]?.name || null;
    renderTables();
    document.dispatchEvent(new CustomEvent('queryspace:tables-updated', { detail: { tables } }));
  }
  async function loadSavedQueries() {
    const data = await api('/api/queries');
    queries = data.queries || [];
    ui.savedList.replaceChildren();
    if (!queries.length) {
      ui.savedList.append(el('p', 'ide-muted-message', 'Save a useful query to keep it here.'));
      return;
    }
    queries.forEach((query) => {
      const button = el('button', 'ide-saved-query');
      button.type = 'button';
      button.dataset.savedQuery = String(query.id);
      button.append(el('span', '', '⌘'), el('span', '', query.name));
      ui.savedList.append(button);
    });
  }
  function renderSchema(info) {
    const columns = ['column', 'type', 'nullable', 'key'];
    const rows = info.columns.map((column) => [column.name, column.type, column.notnull ? 'no' : 'yes', column.primary ? 'primary' : '']);
    showData(columns, rows, { total: rows.length, rowSummary: `${rows.length} column${rows.length === 1 ? '' : 's'} · ${info.row_count} rows in ${info.name}`, allowExport: false });
  }
  async function showSchema() {
    const sql = ui.query.value;
    const from = /\bfrom\s+(?:"([^"]+)"|`([^`]+)`|\[([^\]]+)\]|([\w]+))/i.exec(sql);
    const name = from?.slice(1).find(Boolean) || currentTable;
    if (!name) { showData([], [], { emptyText: 'Choose a table first to inspect its schema.' }); return; }
    try {
      const data = await api(`/api/table?name=${encodeURIComponent(name)}`);
      currentTable = name;
      renderSchema(data.table);
      ui.elapsed.textContent = 'Table schema';
    } catch (error) {
      showData([], [], { emptyText: error.message, rowSummary: 'Could not load schema' });
    }
  }
  async function selectTable(name) {
    currentTable = name;
    currentQueryName = `${name} · table preview`;
    ui.title.textContent = currentQueryName;
    ui.query.value = sqlFromTable(name);
    refreshLineNumbers();
    activeView = 'results';
    document.querySelectorAll('[data-ide-view]').forEach((tab) => {
      const selected = tab.dataset.ideView === 'results';
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-selected', String(selected));
    });
    renderTables();
    await runQuery();
  }
  function renderFilePreview(info) {
    ui.preview.replaceChildren();
    const banner = el('div', 'ide-preview-heading', `${info.row_count} data row${info.row_count === 1 ? '' : 's'} · ${info.headers.length} columns · first five rows shown`);
    ui.preview.append(banner);
    const table = el('table', 'ide-preview-table');
    const thead = el('thead'); const headRow = el('tr');
    info.headers.forEach((header) => headRow.append(el('th', '', header)));
    thead.append(headRow); table.append(thead);
    const tbody = el('tbody');
    (info.sample_rows || []).forEach((row) => {
      const tr = el('tr');
      row.forEach((value) => tr.append(el('td', '', value == null ? '' : value)));
      tbody.append(tr);
    });
    table.append(tbody); ui.preview.append(table);
  }
  async function refreshImportPreview() {
    if (!pendingFile) return;
    const info = await api('/api/inspect', { method: 'POST', body: JSON.stringify({ filename: pendingFile.filename, data_base64: pendingFile.data_base64, worksheet: ui.worksheet.value || undefined }) });
    pendingFile.info = info;
    if (info.sheets?.length) {
      ui.worksheetWrap.hidden = false;
      const previous = ui.worksheet.value;
      ui.worksheet.replaceChildren();
      info.sheets.forEach((sheet) => {
        const option = el('option', '', sheet); option.value = sheet; ui.worksheet.append(option);
      });
      ui.worksheet.value = info.sheet || (info.sheets.includes(previous) ? previous : info.sheets[0]);
    } else {
      ui.worksheetWrap.hidden = true;
      ui.worksheet.replaceChildren();
    }
    renderFilePreview(info);
    ui.importConfirm.disabled = false;
    ui.importMessage.textContent = '';
  }
  function openImport() { ui.fileInput.click(); }
  function bytesToBase64(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
    return btoa(binary);
  }
  async function fileChosen(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'tsv', 'txt', 'xlsx', 'xlsm', 'xls'].includes(ext)) { toast('Choose a CSV or Excel file (.xlsx or .xlsm).'); return; }
    if (file.size > 24 * 1024 * 1024) { toast('Files must be 24 MB or smaller.'); return; }
    ui.importMessage.textContent = 'Reading your file and checking its columns…';
    ui.importMeta.textContent = `${file.name} · ${(file.size / 1024).toFixed(file.size > 1024 * 1024 ? 0 : 1)} KB`;
    ui.importName.value = safeName(file.name.replace(/\.[^.]+$/, ''));
    ui.preview.replaceChildren(el('p', 'ide-muted-message', 'Reading preview…'));
    ui.worksheetWrap.hidden = true;
    ui.importConfirm.disabled = true;
    pendingFile = { filename: file.name, data_base64: bytesToBase64(await file.arrayBuffer()) };
    ui.importDialog.showModal();
    try { await refreshImportPreview(); }
    catch (error) { ui.importMessage.textContent = error.message; ui.preview.replaceChildren(el('p', 'ide-muted-message', 'The file could not be previewed.')); }
  }
  async function performImport(event) {
    event.preventDefault();
    if (!pendingFile) return;
    const tableName = safeName(ui.importName.value);
    if (!tableName) { ui.importMessage.textContent = 'Enter a table name.'; return; }
    ui.importConfirm.disabled = true;
    ui.importConfirm.textContent = 'Importing…';
    ui.importMessage.textContent = 'Creating a table and inserting your rows…';
    try {
      const imported = await api('/api/import', { method: 'POST', body: JSON.stringify({ ...pendingFile, table_name: tableName, worksheet: ui.worksheet.value || undefined }) });
      ui.importDialog.close();
      pendingFile = null;
      ui.fileInput.value = '';
      await loadTables();
      toast(`Imported ${imported.row_count} rows as ${imported.table}.`);
      await selectTable(imported.table);
    } catch (error) {
      ui.importMessage.textContent = error.message;
      ui.importConfirm.disabled = false;
    } finally {
      ui.importConfirm.textContent = 'Import table';
    }
  }
  function openSaveDialog() {
    ui.saveMessage.textContent = '';
    ui.saveName.value = currentQueryName === 'Untitled query' ? '' : currentQueryName.replace(/\s+·\s+table preview$/, '');
    ui.saveDialog.showModal();
    setTimeout(() => ui.saveName.focus(), 50);
  }
  async function saveQuery(event) {
    event.preventDefault();
    ui.saveMessage.textContent = '';
    try {
      const saved = await api('/api/queries', { method: 'POST', body: JSON.stringify({ name: ui.saveName.value.trim(), sql: ui.query.value }) });
      currentQueryName = saved.query.name;
      ui.title.textContent = currentQueryName;
      ui.saveDialog.close();
      await loadSavedQueries();
      toast(`Saved “${saved.query.name}” in this database.`);
    } catch (error) { ui.saveMessage.textContent = error.message; }
  }
  function downloadCsv() {
    if (!lastResult?.columns?.length) return;
    const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [lastResult.columns, ...lastResult.rows].map((row) => row.map(quote).join(',')).join('\r\n');
    const blob = new Blob(['\uFEFF', rows], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `queryspace-results-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    toast('Query results exported as CSV.');
  }
  async function initialize() {
    refreshLineNumbers();
    try {
      const status = await api('/api/status');
      setConnected(true, `${status.database} · ${status.table_count} tables`);
      await Promise.all([loadTables(), loadSavedQueries()]);
      await runQuery();
    } catch (error) {
      setConnected(false);
      showData([], [], { emptyText: error.message, rowSummary: 'Local SQL service is not connected', allowExport: false });
    }
  }
  ui.run.addEventListener('click', runQuery);
  ui.query.addEventListener('input', refreshLineNumbers);
  ui.query.addEventListener('scroll', () => { ui.lineNumbers.scrollTop = ui.query.scrollTop; });
  ui.query.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); runQuery(); }
    if (event.key === 'Tab') { event.preventDefault(); const start = ui.query.selectionStart; ui.query.setRangeText('  ', start, ui.query.selectionEnd, 'end'); refreshLineNumbers(); }
  });
  ui.tableSearch.addEventListener('input', renderTables);
  ui.tableList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-query-table]');
    if (button) selectTable(button.dataset.queryTable);
  });
  ui.savedList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-saved-query]');
    if (!button) return;
    const query = queries.find((item) => String(item.id) === button.dataset.savedQuery);
    if (!query) return;
    currentQueryName = query.name; ui.title.textContent = query.name; ui.query.value = query.sql; refreshLineNumbers();
    setRunStatus('Saved query loaded · press Run SQL to execute.'); ui.query.focus();
  });
  document.querySelectorAll('[data-ide-view]').forEach((button) => button.addEventListener('click', async () => {
    activeView = button.dataset.ideView;
    document.querySelectorAll('[data-ide-view]').forEach((tab) => {
      const selected = tab === button; tab.classList.toggle('is-active', selected); tab.setAttribute('aria-selected', String(selected));
    });
    if (activeView === 'schema') await showSchema();
    else if (lastResult) showData(lastResult.columns, lastResult.rows, { total: lastResult.row_count, truncated: lastResult.truncated, allowExport: true });
    else showData([], [], { emptyText: 'Run a query to see its results here.' });
  }));
  $('#ide-import-top').addEventListener('click', openImport);
  ui.fileInput.addEventListener('change', (event) => fileChosen(event.target.files?.[0]));
  ui.worksheet.addEventListener('change', () => refreshImportPreview().catch((error) => { ui.importMessage.textContent = error.message; }));
  ui.importForm.addEventListener('submit', performImport);
  $('#ide-import-cancel').addEventListener('click', () => { ui.importDialog.close(); pendingFile = null; ui.fileInput.value = ''; });
  $('#ide-import-close').addEventListener('click', () => { ui.importDialog.close(); pendingFile = null; ui.fileInput.value = ''; });
  ui.saveForm.addEventListener('submit', saveQuery);
  $('#ide-save-query').addEventListener('click', openSaveDialog);
  $('#ide-new-query').addEventListener('click', () => {
    currentTable = tables[0]?.name || null; currentQueryName = 'Untitled query'; ui.title.textContent = currentQueryName;
    ui.query.value = currentTable ? sqlFromTable(currentTable) : 'SELECT 1 AS welcome;'; refreshLineNumbers(); ui.query.focus();
    setRunStatus('New query ready · write SQL and run it.');
  });
  $('#ide-save-cancel').addEventListener('click', () => ui.saveDialog.close());
  $('#ide-save-close').addEventListener('click', () => ui.saveDialog.close());
  $('#ide-copy-query').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(ui.query.value); toast('SQL copied to clipboard.'); }
    catch { ui.query.focus(); ui.query.select(); toast('Query selected — press Ctrl+C to copy.'); }
  });
  ui.export.addEventListener('click', downloadCsv);
  initialize();
})();

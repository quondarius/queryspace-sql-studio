(() => {
  'use strict';
  const API_BASE = window.location.port === '5501' && ['127.0.0.1', 'localhost'].includes(window.location.hostname)
    ? `http://${window.location.hostname}:5502`
    : window.location.origin;
  const apiUrl = (path) => new URL(path, API_BASE).toString();
  const $ = (selector, root = document) => root.querySelector(selector);
  const ui = {
    canvas: $('#db-canvas'), cards: $('#db-table-cards'), svg: $('#db-connectors'), viewport: $('#db-canvas-viewport'),
    diagramTab: $('#db-tab-diagram'), sqlTab: $('#db-tab-sql'), diagramView: $('#db-diagram-view'), sqlView: $('#db-sql-view'),
    tableTotal: $('#db-table-total'), relationTotal: $('#db-relation-total'), status: $('#db-diagram-status'), tableList: $('#ide-table-list'), savedList: $('#ide-saved-list')
  };
  let tables = [];
  let relationships = [];
  let resizeObserver;
  const NS = 'http://www.w3.org/2000/svg';
  const makeSvg = (tag, attrs = {}) => {
    const node = document.createElementNS(NS, tag);
    Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value)));
    return node;
  };
  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  };

  function activateView(which) {
    const diagram = which === 'diagram';
    ui.diagramTab.classList.toggle('is-active', diagram);
    ui.sqlTab.classList.toggle('is-active', !diagram);
    ui.diagramTab.setAttribute('aria-selected', String(diagram));
    ui.sqlTab.setAttribute('aria-selected', String(!diagram));
    ui.diagramView.hidden = !diagram;
    ui.sqlView.hidden = diagram;
    if (diagram) requestAnimationFrame(drawRelationships);
  }

  function renderTableCard(table, index) {
    const card = make('article', 'db-table-card');
    card.id = `schema-table-${index}`;
    card.dataset.tableName = table.name;
    const header = make('button', 'db-table-card-header');
    header.type = 'button';
    header.dataset.cardTable = table.name;
    header.setAttribute('aria-label', `Open SQL query for ${table.name}`);
    header.append(make('span', 'db-table-symbol', '▦'), make('span', 'db-table-title', table.name), make('span', 'db-table-rowcount', `${table.row_count} rows`));
    card.append(header);

    const columns = make('div', 'db-table-cols');
    if (!table.columns?.length) columns.append(make('div', 'db-loading', 'No columns to display.'));
    (table.columns || []).forEach((column) => {
      const row = make('div', 'db-table-col');
      const name = make('span', 'db-table-col-name');
      const isForeign = relationships.some((edge) => edge.from_table === table.name && edge.from_column === column.name);
      const key = make('span', `db-key-mark${column.primary ? '' : isForeign ? ' is-foreign' : ' is-empty'}`, column.primary ? '◆' : isForeign ? '↗' : '·');
      key.title = column.primary ? 'Primary key' : isForeign ? 'Related key' : '';
      name.append(key, make('span', '', column.name));
      row.append(name, make('span', 'db-type-pill', column.type || 'TEXT'));
      columns.append(row);
    });
    card.append(columns);

    const footer = make('div', 'db-card-foot');
    const source = table.source?.source_file ? `Imported · ${table.source.source_file}` : table.name === 'customers' || table.name === 'orders' ? 'Sample table' : 'SQLite table';
    footer.append(make('span', '', source));
    const query = make('button', 'db-card-query', 'Query table →');
    query.type = 'button';
    query.dataset.cardQuery = table.name;
    footer.append(query);
    card.append(footer);
    return card;
  }

  function renderTables() {
    ui.cards.replaceChildren();
    ui.tableTotal.textContent = String(tables.length);
    ui.relationTotal.textContent = String(relationships.length);
    if (!tables.length) {
      const empty = make('div', 'db-empty');
      empty.append(make('strong', '', 'Your database is ready for tables'), document.createTextNode('Import a CSV or Excel workbook and its table will appear here.'));
      ui.cards.append(empty);
      ui.status.textContent = 'Import a file to start your schema';
      return;
    }
    tables.forEach((table, index) => ui.cards.append(renderTableCard(table, index)));
    const relationLabel = relationships.length === 1 ? 'relationship' : 'relationships';
    ui.status.textContent = relationships.length ? `${relationships.length} ${relationLabel} mapped from keys` : 'No matching key relationships detected yet';
    requestAnimationFrame(drawRelationships);
  }

  function drawRelationships() {
    if (!ui.canvas || ui.diagramView.hidden) return;
    ui.svg.replaceChildren();
    const width = Math.max(ui.canvas.clientWidth, ui.canvas.scrollWidth);
    const height = Math.max(ui.canvas.clientHeight, ui.canvas.scrollHeight);
    ui.svg.setAttribute('width', width);
    ui.svg.setAttribute('height', height);
    ui.svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const defs = makeSvg('defs');
    const gradient = makeSvg('linearGradient', { id: 'db-edge-glow', x1: '0', y1: '0', x2: '1', y2: '0' });
    gradient.append(makeSvg('stop', { offset: '0%', 'stop-color': '#b794ff' }), makeSvg('stop', { offset: '100%', 'stop-color': '#77ded2' }));
    defs.append(gradient);
    ui.svg.append(defs);
    const canvasRect = ui.canvas.getBoundingClientRect();
    relationships.forEach((edge) => {
      const source = [...ui.cards.children].find((card) => card.dataset.tableName === edge.from_table);
      const target = [...ui.cards.children].find((card) => card.dataset.tableName === edge.to_table);
      if (!source || !target) return;
      const a = source.getBoundingClientRect();
      const b = target.getBoundingClientRect();
      const ax = a.left - canvasRect.left, ay = a.top - canvasRect.top;
      const bx = b.left - canvasRect.left, by = b.top - canvasRect.top;
      let sx, sy, tx, ty, c1x, c2x;
      if (Math.abs((bx + b.width / 2) - (ax + a.width / 2)) > Math.abs((by + b.height / 2) - (ay + a.height / 2))) {
        const forward = bx > ax;
        sx = forward ? ax + a.width : ax; sy = ay + a.height * .5;
        tx = forward ? bx : bx + b.width; ty = by + b.height * .5;
        const bend = Math.max(44, Math.abs(tx - sx) * .42);
        c1x = sx + (forward ? bend : -bend); c2x = tx - (forward ? bend : -bend);
        const path = makeSvg('path', { d: `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`, class: 'db-edge-path' });
        ui.svg.append(path);
      } else {
        const forward = by > ay;
        sx = ax + a.width * .5; sy = forward ? ay + a.height : ay;
        tx = bx + b.width * .5; ty = forward ? by : by + b.height;
        const bend = Math.max(38, Math.abs(ty - sy) * .38);
        const c1y = sy + (forward ? bend : -bend), c2y = ty - (forward ? bend : -bend);
        ui.svg.append(makeSvg('path', { d: `M ${sx} ${sy} C ${sx} ${c1y}, ${tx} ${c2y}, ${tx} ${ty}`, class: 'db-edge-path' }));
      }
      ui.svg.append(makeSvg('circle', { cx: sx, cy: sy, r: 3.2, class: 'db-edge-dot' }), makeSvg('circle', { cx: tx, cy: ty, r: 3.2, class: 'db-edge-dot' }));
      const label = makeSvg('text', { x: (sx + tx) / 2, y: (sy + ty) / 2 - 6, 'text-anchor': 'middle', class: 'db-edge-label' });
      label.textContent = `${edge.from_column} → ${edge.to_column}`;
      ui.svg.append(label);
    });
  }

  async function loadDiagram() {
    try {
      const response = await fetch(apiUrl('/api/tables'), { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Schema request failed (${response.status})`);
      tables = payload.tables || [];
      relationships = payload.relationships || [];
      renderTables();
      if (ui.tableList) {
        const filter = $('#ide-table-search')?.value?.trim().toLowerCase() || '';
        if (filter && !tables.some((table) => table.name.toLowerCase().includes(filter))) ui.status.textContent = 'Schema loaded · no table matches the current filter';
      }
    } catch (error) {
      ui.cards.replaceChildren();
      const empty = make('div', 'db-empty');
      empty.append(make('strong', '', 'Could not map the database yet'), document.createTextNode(`${error.message}. Start the local Queryspace service to load the schema.`));
      ui.cards.append(empty);
      ui.status.textContent = 'Database unavailable';
      ui.tableTotal.textContent = '—'; ui.relationTotal.textContent = '—';
    }
  }

  function queryTable(name) {
    activateView('sql');
    const sidebarButton = [...document.querySelectorAll('#ide-table-list [data-query-table]')].find((button) => button.dataset.queryTable === name);
    if (sidebarButton) sidebarButton.click();
  }

  ui.diagramTab.addEventListener('click', () => activateView('diagram'));
  ui.sqlTab.addEventListener('click', () => activateView('sql'));
  ui.cards.addEventListener('click', (event) => {
    const button = event.target.closest('[data-card-table], [data-card-query]');
    if (button) queryTable(button.dataset.cardTable || button.dataset.cardQuery);
  });
  ui.tableList.addEventListener('click', (event) => { if (event.target.closest('[data-query-table]')) activateView('sql'); });
  ui.savedList.addEventListener('click', (event) => { if (event.target.closest('[data-saved-query]')) activateView('sql'); });
  document.addEventListener('queryspace:tables-updated', loadDiagram);
  $('#ide-table-search').addEventListener('input', () => { if (!$('#ide-table-search').value.trim()) loadDiagram(); });
  if ('ResizeObserver' in window) { resizeObserver = new ResizeObserver(() => requestAnimationFrame(drawRelationships)); resizeObserver.observe(ui.canvas); }
  window.addEventListener('resize', () => requestAnimationFrame(drawRelationships), { passive: true });
  loadDiagram();
})();

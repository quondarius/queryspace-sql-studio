const queryInput = document.querySelector('#query-input');
const runButton = document.querySelector('#run-query');
const resultHead = document.querySelector('#result-head');
const resultBody = document.querySelector('#result-body');
const rowSummary = document.querySelector('#row-summary');
const executionTime = document.querySelector('#execution-time');
const toast = document.querySelector('#toast');
const queryTabs = [...document.querySelectorAll('.query-tab[data-query]')];
const resultTabs = [...document.querySelectorAll('.result-tab[data-view]')];
const sampleQueries = {
  customers: `SELECT\n  customer_name,\n  plan,\n  monthly_spend\nFROM customers\nWHERE status = 'active'\nORDER BY monthly_spend DESC\nLIMIT 5;`,
  revenue: `SELECT\n  DATE_TRUNC('week', order_date) AS week,\n  COUNT(*) AS orders,\n  SUM(total) AS revenue\nFROM orders\nGROUP BY 1\nORDER BY 1 DESC\nLIMIT 5;`
};
const datasets = {
  customers: {
    count: 5,
    columns: ['customer_name', 'plan', 'monthly_spend'],
    rows: [
      ['Atlas Studio', 'Growth', '$4,280'],
      ['Northstar Labs', 'Scale', '$3,840'],
      ['Common Ground', 'Growth', '$2,760'],
      ['Paper Plane Co.', 'Starter', '$1,920'],
      ['Sunroom Health', 'Growth', '$1,640']
    ],
    schema: [['customer_id', 'string', 'Primary key'], ['customer_name', 'string', 'Customer name'], ['plan', 'string', 'Current plan'], ['monthly_spend', 'decimal', 'Monthly spend'], ['status', 'string', 'Account status']]
  },
  revenue: {
    count: 5,
    columns: ['week', 'orders', 'revenue'],
    rows: [['2026-11-09', '1,248', '$86,420'], ['2026-11-02', '1,193', '$79,850'], ['2026-10-26', '1,106', '$74,320'], ['2026-10-19', '1,094', '$71,680'], ['2026-10-12', '1,027', '$68,940']],
    schema: [['order_id', 'string', 'Primary key'], ['order_date', 'date', 'Date placed'], ['customer_id', 'string', 'Customer reference'], ['total', 'decimal', 'Order total'], ['status', 'string', 'Order status']]
  },
  products: {
    count: 5,
    columns: ['product_name', 'category', 'units_sold'],
    rows: [['Studio plan', 'Subscription', '2,840'], ['Field Notes', 'Merchandise', '1,164'], ['Growth plan', 'Subscription', '940'], ['Desk Kit', 'Merchandise', '728'], ['Scale plan', 'Subscription', '416']],
    schema: [['product_id', 'string', 'Primary key'], ['product_name', 'string', 'Product name'], ['category', 'string', 'Product type'], ['units_sold', 'integer', 'Units sold'], ['unit_price', 'decimal', 'Unit price']]
  }
};
let activeDataset = 'customers';
let activeView = 'results';
let toastTimer;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

function renderOutput() {
  const data = datasets[activeDataset];
  const isSchema = activeView === 'schema';
  const columns = isSchema ? ['column', 'type', 'description'] : data.columns;
  const rows = isSchema ? data.schema : data.rows;
  resultHead.innerHTML = `<tr>${columns.map((column) => `<th scope="col">${column}</th>`).join('')}</tr>`;
  resultBody.innerHTML = rows.map((row) => `<tr>${row.map((cell, index) => {
    let className = '';
    if (isSchema && index === 1) className = 'cell-plan';
    else if (!isSchema && index === 0) className = '';
    else if (!isSchema && index === 1 && activeDataset === 'customers') className = 'cell-plan';
    else if (index > 0) className = 'cell-muted';
    return `<td class="${className}">${cell}</td>`;
  }).join('')}</tr>`).join('');
  document.querySelector('.result-count').textContent = isSchema ? String(data.schema.length) : String(data.count);
  rowSummary.textContent = isSchema ? `${data.schema.length} columns in sample table` : `Showing ${data.rows.length} sample rows`;
  resultTabs.forEach((tab) => {
    const selected = tab.dataset.view === activeView;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', String(selected));
  });
}

function chooseDataset(sql) {
  const query = sql.toLowerCase();
  if (query.includes('product')) return 'products';
  if (query.includes('order') || query.includes('revenue')) return 'revenue';
  return 'customers';
}

queryTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    queryTabs.forEach((item) => {
      const selected = item === tab;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    queryInput.value = sampleQueries[tab.dataset.query];
    activeDataset = tab.dataset.query;
    activeView = 'results';
    renderOutput();
    executionTime.innerHTML = '<span></span> Ready to run';
  });
});

resultTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activeView = tab.dataset.view;
    renderOutput();
  });
});

document.querySelectorAll('.rail-button').forEach((button, index) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.rail-button').forEach((item) => item.classList.remove('rail-active'));
    button.classList.add('rail-active');
    if (index === 1) {
      activeView = 'schema';
      renderOutput();
      showToast('Table schema is shown beside the query.');
    } else if (index === 0) {
      activeView = 'results';
      renderOutput();
      showToast('SQL editor selected.');
    } else {
      showToast('Switch between the sample queries using the tabs above.');
    }
  });
});

document.querySelector('.new-query').addEventListener('click', () => {
  queryTabs.forEach((tab) => {
    tab.classList.remove('is-active');
    tab.setAttribute('aria-selected', 'false');
  });
  queryInput.value = 'SELECT *\\nFROM customers\\nLIMIT 10;';
  activeDataset = 'customers';
  activeView = 'results';
  renderOutput();
  executionTime.innerHTML = '<span></span> Ready to run';
  queryInput.focus();
  showToast('New sample query ready to edit.');
});

runButton.addEventListener('click', () => {
  if (!queryInput.value.trim()) {
    showToast('Add a SQL query before running it.');
    queryInput.focus();
    return;
  }
  activeDataset = chooseDataset(queryInput.value);
  activeView = 'results';
  renderOutput();
  runButton.disabled = true;
  runButton.querySelector('span').textContent = 'Running…';
  executionTime.innerHTML = '<span style="background:#c69aff;box-shadow:0 0 8px #c69aff"></span> Running sample query…';
  window.setTimeout(() => {
    runButton.disabled = false;
    runButton.querySelector('span').textContent = 'Run query';
    executionTime.innerHTML = '<span></span> Finished just now';
    showToast('Sample query complete — results updated.');
  }, 650);
});

document.querySelector('#copy-query').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(queryInput.value);
    showToast('SQL query copied to clipboard.');
  } catch {
    queryInput.focus();
    queryInput.select();
    showToast('Query selected — copy it with Ctrl+C.');
  }
});

document.querySelector('#export-results').addEventListener('click', () => {
  const data = datasets[activeDataset];
  const isSchema = activeView === 'schema';
  const columns = isSchema ? ['column', 'type', 'description'] : data.columns;
  const rows = isSchema ? data.schema : data.rows;
  const csv = [columns, ...rows].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `queryspace-${activeDataset}-${isSchema ? 'schema' : 'results'}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Sample results exported as CSV.');
});

document.querySelectorAll('[data-scroll]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector(button.dataset.scroll)?.scrollIntoView({ behavior: 'smooth' }));
});

const menuToggle = document.querySelector('.mobile-menu-toggle');
const primaryNav = document.querySelector('#primary-nav');
menuToggle.addEventListener('click', () => {
  const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
  menuToggle.setAttribute('aria-expanded', String(!expanded));
  menuToggle.setAttribute('aria-label', expanded ? 'Open navigation' : 'Close navigation');
  primaryNav.classList.toggle('is-open', !expanded);
});
primaryNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    primaryNav.classList.remove('is-open');
  });
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    runButton.click();
  }
  if (event.key === 'Escape' && primaryNav.classList.contains('is-open')) {
    menuToggle.setAttribute('aria-expanded', 'false');
    primaryNav.classList.remove('is-open');
    menuToggle.focus();
  }
});

document.querySelector('#current-year').textContent = String(new Date().getFullYear());
renderOutput();

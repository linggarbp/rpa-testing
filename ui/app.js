/* rpa-studio — the whole page. No framework, no build step: the server serves three files, and a
 * clone-and-run needs nothing else. State is one workflow object plus a "context" path into it. */

const state = {
  projectDir: '',
  file: '',
  workflow: { name: '', steps: [] },
  /** Path of steps-lists from the workflow root to what the canvas is currently editing. */
  context: [],
  selected: null,
  catalog: [],
  /** Entry-point arguments (workflow.arguments) the Run button sends as variables. */
  arguments: {}
};

const $ = (id) => document.getElementById(id);

/* ── Defaults: what a fresh activity looks like when it lands on the canvas ───────────────────── */

const BODIES = {
  'control:if': [{ label: 'then', key: 'then' }, { label: 'else', key: 'else' }],
  'control:repeat': [{ label: 'body', key: 'steps' }],
  'control:while': [{ label: 'body', key: 'steps' }],
  'control:foreach': [{ label: 'body', key: 'steps' }],
  'control:retryScope': [{ label: 'body', key: 'steps' }],
  'control:try': [{ label: 'try', key: 'body' }, { label: 'finally', key: 'finally' }],
  'control:switch': [{ label: 'default', key: 'default' }],
  'excel:forEachRow': [{ label: 'body', key: 'steps' }],
  'file:forEachFile': [{ label: 'body', key: 'steps' }]
};

function blankStep(type, action) {
  const defaults = {
    'web:goto': { url: 'https://' },
    'web:click': { selector: '' },
    'web:type': { selector: '', text: '' },
    'web:getText': { selector: '', saveAs: '' },
    'web:assertText': { text: '' },
    'web:waitForElement': { selector: '' },
    'web:elementExists': { selector: '', saveAs: '' },
    'web:screenshot': {},
    'control:log': { message: '' },
    'control:setVar': { name: '', value: '' },
    'control:math': { name: '', op: 'add', value: '1' },
    'control:delay': { ms: 1000 },
    'control:if': { condition: '', then: [], else: [] },
    'control:repeat': { times: 3, steps: [] },
    'control:while': { condition: '', maxIterations: 10, steps: [] },
    'control:foreach': { items: '', itemName: 'item', steps: [] },
    'control:switch': { expression: '', cases: {}, default: [] },
    'control:try': { body: [], catches: [{ kind: 'business', steps: [] }, { kind: 'application', steps: [] }], finally: [] },
    'control:throw': { message: '', kind: 'application' },
    'control:retryScope': { retries: 3, retryDelayMs: 500, steps: [] },
    'control:invoke': { workflow: 'Framework/Process.json', arguments: {} },
    'queue:addItem': { queue: '', reference: '', data: {} },
    'queue:getTransactionItem': { queue: '', saveAs: 'TransactionItem' },
    'queue:setStatus': { queue: '', status: 'Successful', reason: '${exception.message}' },
    'queue:count': { queue: '', saveAs: 'count' },
    'queue:list': { queue: '' },
    'excel:readRange': { path: 'Data/Input.xlsx', saveAs: 'rows' },
    'excel:writeRange': { path: 'Data/Out.csv', rows: '' },
    'excel:writeCell': { path: 'Data/Out.csv', row: 1, column: 'A', value: '' },
    'excel:forEachRow': { path: 'Data/Input.xlsx', saveAs: 'row', steps: [] },
    'file:forEachFile': { folder: 'Data/Input', pattern: '*', saveAs: 'file', steps: [] },
    'file:move': { from: '', to: '' },
    'file:readText': { path: '', saveAs: 'text' },
    'file:writeText': { path: '', text: '' },
    'file:exists': { path: '', saveAs: 'exists' },
    'file:delete': { path: '' },
    'file:mkdir': { path: '' },
    'config:load': { path: 'config.json' },
    'mail:send': {
      server: { host: 'smtp.example.com', port: 587, user: '${secret.MAIL_USER}', pass: '${secret.MAIL_PASS}' },
      to: '', subject: '', text: ''
    },
    'mail:receive': { search: { unseen: true, sinceDays: 1 }, saveAs: 'messages' },
    'pdf:readText': { path: 'Data/Input/invoice.pdf', saveAs: 'text' },
    'gsheet:append': { spreadsheetId: '', range: 'Sheet1!A1', values: '[["a","b"]]', token: '${secret.GSHEET_TOKEN}' },
    'gsheet:read': { spreadsheetId: '', range: 'Sheet1!A1', token: '${secret.GSHEET_TOKEN}', saveAs: 'rows' },
    'hitl:ask': { prompt: 'Approve this transaction?', choices: ['yes', 'no'], saveAs: 'answer' },
    'data:jsonParse': { text: '', saveAs: 'json' },
    'data:regexMatches': { text: '', pattern: '', saveAs: 'matches' },
    'api:request': { method: 'GET', url: '' },
    'desktop:move': { x: 400, y: 300 },
    'desktop:click': {},
    'desktop:type': { text: '' },
    'desktop:pressKey': { keys: ['Enter'] },
    'desktop:screenshot': { fileName: 'shot' },
    'ocr:recognize': { imagePath: '', saveAs: 'text' },
    'ai-vision:decide': { goal: '' }
  };
  const step = { type, action, ...(defaults[`${type}:${action}`] ?? {}) };
  return step;
}

/* ── Helpers ─────────────────────────────────────────────────────────────────────────────────── */

const api = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? (body.errors ?? []).join('; ') ?? `HTTP ${response.status}`);
  return body;
};

/** Every nested step-list a container owns, as live arrays (edits go straight into the workflow). */
function bodiesOf(step, index) {
  const key = `${step.type}:${step.action}`;
  const bodies = [];
  for (const slot of BODIES[key] ?? []) {
    if (!Array.isArray(step[slot.key])) step[slot.key] = [];
    bodies.push({ path: { index, key: slot.key, label: slot.label }, label: slot.label, steps: step[slot.key] });
  }
  if (key === 'control:try') {
    (step.catches ?? []).forEach((catcher, catcherIndex) => {
      if (!Array.isArray(catcher.steps)) catcher.steps = [];
      bodies.push({ path: { index, catchIndex: catcherIndex, label: `catch ${catcher.kind}` }, label: `catch ${catcher.kind}`, steps: catcher.steps });
    });
  }
  if (key === 'control:switch') {
    for (const [value, branch] of Object.entries(step.cases ?? {})) {
      bodies.push({ path: { index, case: value, label: `case ${value}` }, label: `case ${value}`, steps: branch });
    }
  }
  return bodies;
}

/** The steps array the canvas is editing, and its own breadcrumb of labels. */
function currentContext() {
  let steps = state.workflow.steps;
  const labels = [];
  for (const hop of state.context) {
    if (hop.catchIndex !== undefined) steps = steps[hop.index].catches[hop.catchIndex].steps;
    else if (hop.case !== undefined) steps = steps[hop.index].cases[hop.case];
    else steps = steps[hop.index][hop.key];
    labels.push(hop.label);
  }
  return { steps, labels };
}

function summarise(step) {
  const scalars = Object.entries(step)
    .filter(([key, value]) => key !== 'type' && key !== 'action' && (typeof value === 'string' || typeof value === 'number'))
    .map(([, value]) => String(value).slice(0, 48));
  return `${step.type}.${step.action}${scalars.length ? ' · ' + scalars.join(' · ') : ''}`;
}

/* ── Rendering ───────────────────────────────────────────────────────────────────────────────── */

function renderBreadcrumb() {
  const { labels } = currentContext();
  const crumbs = ['<a data-hop="-1">workflow</a>'];
  labels.forEach((label, index) => crumbs.push(`<a data-hop="${index}">${label}</a>`));
  $('breadcrumb').innerHTML = crumbs.join('<span class="sep">›</span>');
  $('breadcrumb').querySelectorAll('a').forEach((element) => {
    element.onclick = () => {
      const hop = Number(element.dataset.hop);
      state.context = hop < 0 ? [] : state.context.slice(0, hop + 1);
      state.selected = null;
      render();
    };
  });
}

function renderSteps() {
  const { steps } = currentContext();
  const host = $('steps');
  host.innerHTML = '';
  document.body.dataset.type = steps[0]?.type ?? 'web';

  steps.forEach((step, index) => {
    const card = document.createElement('div');
    card.className = 'step' + (state.selected === index ? ' selected' : '');
    card.innerHTML = `
      <div class="head">
        <span class="type">${step.type}.${step.action}</span>
        <span class="summary">${summarise(step)}</span>
        <span class="actions">
          <button class="ghost small" data-up>↑</button>
          <button class="ghost small" data-down>↓</button>
          <button class="ghost small" data-del>✕</button>
        </span>
      </div>`;

    card.onclick = () => { state.selected = index; render(); };
    card.querySelector('[data-up]').onclick = (event) => {
      event.stopPropagation();
      if (index > 0) { [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; state.selected = index - 1; render(); }
    };
    card.querySelector('[data-down]').onclick = (event) => {
      event.stopPropagation();
      if (index < steps.length - 1) { [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]; state.selected = index + 1; render(); }
    };
    card.querySelector('[data-del]').onclick = (event) => {
      event.stopPropagation();
      steps.splice(index, 1);
      state.selected = null;
      render();
    };

    for (const body of bodiesOf(step, index)) {
      const box = document.createElement('div');
      box.className = 'body';
      box.innerHTML = `<div class="label">${body.label} — ${body.steps.length} step(s)</div>`;
      for (const [childIndex, child] of body.steps.entries()) {
        const line = document.createElement('div');
        line.className = 'step';
        line.style.marginBottom = '4px';
        line.innerHTML = `<div class="head"><span class="type">${child.type}.${child.action}</span><span class="summary">${summarise(child)}</span></div>`;
        line.onclick = (event) => {
          event.stopPropagation();
          state.context = [...state.context, { ...body.path, label: body.label }];
          state.selected = childIndex;
          render();
        };
        box.appendChild(line);
      }
      const add = document.createElement('div');
      add.className = 'add';
      add.textContent = '+ select this body to add steps into it';
      add.onclick = (event) => {
        event.stopPropagation();
        state.context = [...state.context, { ...body.path, label: body.label }];
        state.selected = null;
        render();
      };
      box.appendChild(add);
      card.appendChild(box);
    }

    host.appendChild(card);
  });
}

function renderInspector() {
  const { steps } = currentContext();
  const step = steps[state.selected];
  const host = $('props');
  host.innerHTML = '';
  if (!step) {
    $('props-hint').classList.remove('hidden');
    // With nothing selected, the panel shows the workflow's entry-point arguments (its run inputs).
    const declared = Object.entries(state.workflow.arguments ?? {});
    if (declared.length > 0) {
      const box = document.createElement('div');
      box.innerHTML = '<h4 style="margin:8px 0 6px;font-size:11px;letter-spacing:.08em;color:var(--muted);text-transform:uppercase">Arguments</h4>';
      for (const [name, spec] of declared) {
        const field = document.createElement('div');
        field.className = 'field';
        const required = spec && typeof spec === 'object' && spec.required ? ' *' : '';
        field.innerHTML = `<label>${name}${required}</label><input spellcheck="false">`;
        const input = field.querySelector('input');
        input.value = state.arguments[name] ?? '';
        input.onchange = () => { state.arguments[name] = input.value; };
        box.appendChild(field);
      }
      host.appendChild(box);
    }
    return;
  }
  $('props-hint').classList.add('hidden');

  const field = (key, value) => {
    const box = document.createElement('div');
    box.className = 'field';
    const multiline = typeof value !== 'string' || value.length > 60;
    box.innerHTML = `<label>${key}</label>` + (multiline
      ? `<textarea data-key="${key}"></textarea>`
      : `<input data-key="${key}" spellcheck="false">`);
    const input = box.querySelector('[data-key]');
    input.value = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
    input.onchange = () => {
      const raw = input.value;
      try {
        step[key] = raw.trim() === '' ? '' : JSON.parse(raw);
      } catch {
        step[key] = raw;
      }
      renderSteps();
    };
    host.appendChild(box);
  };

  const title = document.createElement('div');
  title.className = 'hint';
  title.textContent = `${step.type}.${step.action} — ${Object.keys(step).length} field(s)`;
  host.appendChild(title);

  for (const [key, value] of Object.entries(step)) {
    if (key === 'type' || key === 'action') continue;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && ['cases', 'arguments', 'data'].includes(key)) { field(key, value); continue; }
    if (value !== null && typeof value === 'object') continue; // step lists are edited on the canvas
    field(key, value);
  }

  const resilience = document.createElement('div');
  resilience.className = 'hint';
  resilience.style.marginTop = '10px';
  resilience.textContent = 'resilience: timeoutMs · retry · retryDelayMs · continueOnError · delayBeforeMs · delayAfterMs';
  host.appendChild(resilience);

  const addRow = document.createElement('div');
  addRow.className = 'row';
  addRow.innerHTML = `<input id="new-field" placeholder="new field name"><button class="ghost small" id="add-field">add</button>`;
  host.appendChild(addRow);
  addRow.querySelector('#add-field').onclick = () => {
    const name = addRow.querySelector('#new-field').value.trim();
    if (!name) return;
    step[name] = '';
    render();
  };
}

function renderPalette() {
  const filter = $('palette-filter').value.trim().toLowerCase();
  const host = $('palette-groups');
  host.innerHTML = '';
  for (const group of state.catalog) {
    const actions = group.actions.filter((action) => !filter || `${group.type}.${action}`.toLowerCase().includes(filter));
    if (actions.length === 0) continue;
    const box = document.createElement('div');
    box.className = 'palette-group';
    box.innerHTML = `<h4>${group.type}</h4>`;
    for (const action of actions) {
      const item = document.createElement('div');
      item.className = 'palette-item';
      item.innerHTML = `<b>${action}</b> <code>${group.type}</code>`;
      item.onclick = () => {
        const { steps } = currentContext();
        steps.push(blankStep(group.type, action));
        state.selected = steps.length - 1;
        render();
      };
      box.appendChild(item);
    }
    host.appendChild(box);
  }
}

function render() {
  renderBreadcrumb();
  renderSteps();
  renderInspector();
}

/* ── Loading, saving, running ────────────────────────────────────────────────────────────────── */

async function loadProject() {
  const project = await api('/api/project');
  state.projectDir = project.dir;
  $('project-dir').value = project.dir;
  const picker = $('workflow-picker');
  picker.innerHTML = project.workflows
    .map((entry) => `<option value="${entry.file}">${entry.file} (${entry.steps} steps)</option>`)
    .join('');
  const preferred = project.workflows.find((entry) => /^Main\.json$/.test(entry.file)) ?? project.workflows[0];
  if (preferred) {
    picker.value = preferred.file;
    await loadWorkflow(preferred.file);
  } else {
    $('errors').textContent = 'No workflow file in this folder yet — run `rpa init --template transactional` first.';
  }
}

async function loadWorkflow(file) {
  const loaded = await api(`/api/workflow?file=${encodeURIComponent(file)}`);
  state.file = file;
  state.workflow = loaded.workflow;
  state.context = [];
  state.selected = null;
  // Arguments keep their defaults; the panel lets a user override them for one run.
  state.arguments = {};
  for (const [name, spec] of Object.entries(state.workflow.arguments ?? {})) {
    if (spec && typeof spec === 'object' && 'default' in spec && spec.default !== undefined) state.arguments[name] = String(spec.default);
  }
  $('errors').textContent = loaded.errors.length ? loaded.errors.join('\n') : '';
  render();
}

async function save() {
  try {
    await api('/api/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file: state.file, workflow: state.workflow })
    });
    $('status').textContent = 'saved';
    $('status').className = 'pill passed';
  } catch (error) {
    $('errors').textContent = String(error.message);
    $('status').textContent = 'invalid';
    $('status').className = 'pill failed';
  }
}

async function run() {
  const console_ = $('console');
  console_.textContent = '';
  $('status').textContent = 'running';
  $('status').className = 'pill running';
  $('run').disabled = true;
  switchTab('console');

  const response = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: state.file, variables: state.arguments })
  });
  if (!response.ok || !response.body) {
    const body = await response.json().catch(() => ({}));
    console_.textContent = (body.errors ?? [body.error ?? 'run failed']).join('\n');
    $('status').textContent = 'failed';
    $('status').className = 'pill failed';
    $('run').disabled = false;
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (!event || !data) continue;
      const payload = JSON.parse(data);
      if (event === 'log') {
        const line = document.createElement('div');
        line.className = payload.level;
        line.textContent = `[${payload.level}] ${payload.message}`;
        console_.appendChild(line);
        console_.scrollTop = console_.scrollHeight;
      }
      if (event === 'finished') {
        $('status').textContent = payload.status.toLowerCase();
        $('status').className = `pill ${payload.status === 'Passed' ? 'passed' : 'failed'}`;
        $('run-summary').textContent = `${payload.status} — ${payload.stepsRun} step(s) in ${payload.durationMs} ms${payload.error ? ` — ${payload.error}` : ''}`;
        $('run').disabled = false;
      }
    }
  }
}

async function loadQueue() {
  const name = $('queue-name').value.trim() || 'InvoiceQueue';
  $('queue-name').value = name;
  try {
    const queue = await api(`/api/queue?name=${encodeURIComponent(name)}`);
    $('queue-counts').textContent = Object.entries(queue.counts).map(([status, count]) => `${status}: ${count}`).join('  ·  ') || 'empty';
    $('queue-table').querySelector('tbody').innerHTML = queue.items
      .map((item) => `<tr><td class="status">${item.status}</td><td>${item.reference}</td><td>${JSON.stringify(item.data)}</td><td>${item.retries ? `retries=${item.retries}` : ''}</td></tr>`)
      .join('');
  } catch (error) {
    $('queue-counts').textContent = String(error.message);
  }
}

async function addQueueItem() {
  const name = $('queue-name').value.trim();
  const reference = $('queue-ref').value.trim();
  if (!name || !reference) return;
  let data = {};
  try { data = JSON.parse($('queue-data').value || '{}'); } catch { /* keep {} */ }
  await fetch('/api/queue/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, reference, data })
  });
  $('queue-ref').value = '';
  await loadQueue();
}

function switchTab(name) {
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('active', button.dataset.tab === name);
  for (const panel of document.querySelectorAll('.tab-panel')) panel.classList.add('hidden');
  $(`tab-${name}`).classList.remove('hidden');
}

/* ── Wiring ──────────────────────────────────────────────────────────────────────────────────── */

for (const button of document.querySelectorAll('.tabs button')) button.onclick = () => switchTab(button.dataset.tab);
$('run').onclick = () => void run();
$('save').onclick = () => void save();
$('palette-filter').oninput = renderPalette;
$('clear-console').onclick = () => { $('console').textContent = ''; };
$('queue-load').onclick = () => void loadQueue();
$('queue-add').onclick = () => void addQueueItem();
$('workflow-picker').onchange = (event) => void loadWorkflow(event.target.value);

state.catalog = (await api('/api/activities')).catalog;
renderPalette();
await loadProject();
switchTab('props');

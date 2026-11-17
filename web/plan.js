let plan = null;
let planOpen = false;
let planBusy = false;
let selectedPlanFile = '';

function planElements(existingIds) {
  if (!planOpen || !plan) return [];
  const proposed = new Set(plan.modules.map(item => item.file));
  const elements = plan.modules.map(item => ({
    group: 'nodes', data: { id: 'plan:' + item.file, label: item.name, planFile: item.file }, classes: 'proposed'
  }));
  for (const item of plan.modules) {
    for (const dependency of item.dependencies) {
      const target = proposed.has(dependency) ? 'plan:' + dependency : 'module:' + dependency;
      if (proposed.has(dependency) || existingIds.has(target)) {
        elements.push({ group: 'edges', data: { source: 'plan:' + item.file, target }, classes: 'proposed' });
      }
    }
  }
  return elements;
}

function showPlanEditor(file) {
  const item = plan?.modules.find(module => module.file === file);
  selectedPlanFile = item?.file ?? '';
  byId('plan-file').value = item?.file ?? '';
  byId('plan-name').value = item?.name ?? '';
  byId('plan-kind').value = item?.kind ?? 'function';
  byId('plan-note').value = item?.note ?? '';
  byId('plan-dependencies').value = item?.dependencies.join('\n') ?? '';
  byId('plan-delete').disabled = !item || planBusy;
  byId('plan-preview').hidden = true;
}

function refreshPlanList() {
  const list = byId('plan-modules');
  list.replaceChildren(...(plan?.modules ?? []).map(item => listRow(item.file + ' · ' + item.name, () => {
    showPlanEditor(item.file);
    cy.elements().unselect();
    const node = cy.getElementById('plan:' + item.file);
    node.select();
    cy.center(node);
  })));
}

function syncPlanControls() {
  byId('plan-save').disabled = planBusy || !plan;
  byId('plan-delete').disabled = planBusy || !selectedPlanFile;
  byId('plan-reload').disabled = planBusy;
  byId('plan-new').disabled = planBusy || !plan;
}

async function requestPlan(modules, nextFile = '') {
  if (planBusy) return;
  planBusy = true;
  syncPlanControls();
  const writing = modules !== undefined;
  byId('plan-status').textContent = writing ? 'Saving…' : 'Loading plan…';
  try {
    const response = await fetch('/api/plan', writing ? {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, revision: plan.revision, modules })
    } : undefined);
    if (!response.ok) throw new Error(await response.text());
    plan = await response.json();
    showPlanEditor(nextFile);
    refreshPlanList();
    if (state.graph) render();
    byId('plan-status').textContent = writing ? 'Saved to .codetolife/plan.json.' :
      plan.modules.length ? plan.modules.length + ' proposed modules.' : 'No proposed modules yet.';
  } catch (error) {
    byId('plan-status').textContent = error.message;
  } finally {
    planBusy = false;
    syncPlanControls();
  }
}

function editPlan(event) {
  event.preventDefault();
  const file = byId('plan-file').value.trim();
  if (!plan || planBusy) return;
  if (plan.modules.some(item => item.file.toLowerCase() === file.toLowerCase() && item.file !== selectedPlanFile)) {
    byId('plan-status').textContent = 'That module path is already in the plan.';
    return;
  }
  const item = {
    file, name: byId('plan-name').value.trim(), kind: byId('plan-kind').value,
    note: byId('plan-note').value.trim(),
    dependencies: byId('plan-dependencies').value.split('\n').map(file => file.trim()).filter(Boolean)
  };
  const modules = plan.modules.map(current => {
    if (current.file === selectedPlanFile) return item;
    if (selectedPlanFile && selectedPlanFile !== file) {
      return { ...current, dependencies: current.dependencies.map(target => target === selectedPlanFile ? file : target) };
    }
    return current;
  });
  if (!selectedPlanFile) modules.push(item);
  requestPlan(modules, file);
}

function previewPlanStub() {
  const name = byId('plan-name').value.trim();
  if (!/^[A-Za-z_$][\w$]{0,79}$/.test(name)) {
    byId('plan-status').textContent = 'Enter an export name before previewing.';
    return;
  }
  const output = byId('plan-preview');
  output.value = byId('plan-kind').value === 'component' ?
    'export function ' + name + '() {\n  return null;\n}\n' :
    'export function ' + name + '(): never {\n  throw new Error("Not implemented");\n}\n';
  output.hidden = false;
  output.focus();
  output.select();
}

function initPlan() {
  syncPlanControls();
  byId('plan-toggle').addEventListener('click', () => {
    planOpen = !planOpen;
    byId('plan-toggle').setAttribute('aria-pressed', String(planOpen));
    byId('plan').hidden = !planOpen;
    if (planOpen && !plan) requestPlan();
    else if (state.graph) render();
  });
  byId('plan-new').addEventListener('click', () => {
    showPlanEditor('');
    byId('plan-file').focus();
  });
  byId('plan-reload').addEventListener('click', () => requestPlan(undefined, selectedPlanFile));
  byId('plan-form').addEventListener('submit', editPlan);
  byId('plan-stub').addEventListener('click', previewPlanStub);
  byId('plan-delete').addEventListener('click', () => {
    const modules = plan.modules.filter(item => item.file !== selectedPlanFile);
    requestPlan(modules.map(item => ({
      ...item, dependencies: item.dependencies.filter(file => file !== selectedPlanFile)
    })));
  });
  cy.on('tap', 'node.proposed', event => showPlanEditor(event.target.data('planFile')));
  cy.on('tap', 'node.module', event => {
    if (!planOpen || !event.originalEvent?.shiftKey) return;
    const file = state.items.get(event.target.id()).file;
    const input = byId('plan-dependencies');
    const lines = input.value.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.includes(file)) input.value = [...lines, file].join('\n');
  });
}

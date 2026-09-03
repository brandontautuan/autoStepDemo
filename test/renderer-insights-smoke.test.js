const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { applyFeedback } = require('../insights');

function element() {
  return {
    hidden: false,
    style: {},
    classList: { toggle() {} },
    addEventListener() {},
    insertAdjacentHTML() {}
  };
}

function insightsRoot() {
  const root = element();
  root.buttons = [];
  root.cards = [];
  Object.defineProperty(root, 'innerHTML', {
    get() { return this._html || ''; },
    set(value) {
      this._html = String(value);
      this.cards = [...this._html.matchAll(/<details class="insight-card[^>]*data-insight-id="([^"]+)"[^>]*>/g)].map((match) => ({
        dataset: { insightId: match[1] }, open: false, focus() {}
      }));
      this.buttons = [...this._html.matchAll(/data-feedback="([^"]+)" data-insight="([^"]+)"/g)].map((match) => {
        const button = {
          dataset: { feedback: match[1], insight: match[2] },
          disabled: false,
          addEventListener(type, listener) { if (type === 'click') this.click = listener; },
          closest() { return { insertAdjacentHTML() {} }; }
        };
        return button;
      });
    }
  });
  root.querySelectorAll = (selector) => {
    if (selector === '[data-feedback]') return root.buttons;
    if (selector === 'details[data-insight-id][open]') return root.cards.filter((card) => card.open);
    if (selector === 'details[data-insight-id]') return root.cards;
    return [];
  };
  return root;
}

function rendererHarness() {
  const elements = new Map();
  const root = insightsRoot();
  elements.set('insightsList', root);
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const persisted = {};
  const fixture = {
    id: 'switch-burst-fixture', type: 'context_switch_burst', category: 'friction', status: null,
    signalLabel: 'Possible friction', confidenceLabel: 'Moderate evidence', title: 'Frequent app switching',
    summary: '5 foreground changes in 15 minutes',
    description: 'Your foreground app changed 5 times during this 15-minute window.',
    whyItMayMatter: 'Frequent switching can fragment work.', whyItMayBeNormal: 'Comparison work can require switching.',
    metrics: { foregroundChanges: 5, distinctApps: 2 },
    evidenceDetails: {
      start: '2026-09-02T10:00:00.000Z', end: '2026-09-02T10:15:00.000Z', foregroundChanges: 5,
      distinctApps: ['Code', 'Terminal'], involvedApps: ['Code', 'Terminal'],
      topRepeated: { app: 'Code', windowTitle: 'Draft', count: 2 },
      appSequence: [{ app: 'Code', windowTitle: 'Draft' }, { app: 'Terminal', windowTitle: 'npm test' }]
    },
    evidence: [
      { start: '2026-09-02T10:00:00.000Z', end: '2026-09-02T10:05:00.000Z', durationMs: 300000, app: 'Code', windowTitle: 'Draft' },
      { start: '2026-09-02T10:05:00.000Z', end: '2026-09-02T10:06:00.000Z', durationMs: 60000, app: 'Terminal', windowTitle: 'npm test' }
    ]
  };
  let currentInsights = [fixture];
  const observer = {
    state: async () => ({ latest: null, history: [], activity: [], running: false }),
    insights: async () => currentInsights,
    feedback: async (id, status) => {
      persisted[id] = { status, updatedAt: '2026-09-02T10:16:00.000Z' };
      currentInsights = applyFeedback([fixture], persisted);
      return { id, ...persisted[id] };
    },
    personalDashboard: async () => ({ generatedAt: '2026-09-02T10:30:00.000Z', range: { start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z', timezone: 'UTC' }, isLive: false, currentWork: null, journal: [], tasksToResume: [], standupDraft: {}, frictionSummary: [] }),
    onSnapshot() {}, memory: async () => ({}), openData() {}, openAccessibility() {}, start() {}, stop() {}, capture() {}, askAgent() {}
  };
  const context = {
    window: { observer }, document: { getElementById: get }, navigator: { platform: 'linux' },
    setInterval() {}, Date, console
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8'), context);
  return { context, root, get, observer, persisted, fixture };
}

test('renderer insight smoke test expands evidence, saves feedback, and renders persisted feedback after reload', async () => {
  const { context, root, observer, persisted, fixture } = rendererHarness();
  context.renderInsights([fixture]);

  assert.match(root.innerHTML, /<details class="insight-card/);
  assert.match(root.innerHTML, /EVIDENCE · 2 intervals/);
  assert.match(root.innerHTML, /Code — Draft/);
  assert.match(root.innerHTML, /Terminal/);

  root.cards[0].open = true;
  context.renderInsights([fixture]);
  assert.equal(root.cards[0].open, true);

  const expected = root.buttons.find((button) => button.dataset.feedback === 'expected');
  assert.ok(expected);
  await expected.click({ preventDefault() {} });
  assert.equal(persisted[fixture.id].status, 'expected');
  assert.match(root.innerHTML, /Expected context/);
  assert.match(root.innerHTML, /Reviewed signals/);
  assert.doesNotMatch(root.innerHTML, /Potential friction/);
  assert.match(root.innerHTML, /Possible friction/);

  // A renderer reload has no local feedback state: it must ask the bridge again.
  context.renderInsights(await observer.insights());
  assert.match(root.innerHTML, /Expected context/);
  assert.match(root.innerHTML, /class="insight-card expected"/);
});

test('renderer displays each saved feedback status as a reviewed signal', () => {
  const { context, root, fixture } = rendererHarness();
  const labels = { correct: 'Confirmed', expected: 'Expected context', incorrect: 'Not a fit', ignore: 'Dismissed' };
  Object.entries(labels).forEach(([status, label]) => {
    context.renderInsights([{ ...fixture, status }]);
    assert.match(root.innerHTML, /Reviewed signals/);
    assert.match(root.innerHTML, new RegExp(label));
  });
});

test('renderer displays the stable personal dashboard envelope with provenance-backed sections', () => {
  const { context, get } = rendererHarness();
  context.renderPersonalDashboard({
    generatedAt: '2026-09-02T10:30:00.000Z',
    range: { start: '2026-09-02T00:00:00.000Z', end: '2026-09-03T00:00:00.000Z', timezone: 'UTC' },
    isLive: true, currentWork: { taskName: 'Draft', app: 'Code', windowTitle: 'Draft', start: '2026-09-02T09:15:00.000Z', end: '2026-09-02T09:20:00.000Z', durationMs: 300000 },
    journal: [{ taskKey: 'code::draft', taskName: 'Draft', app: 'Code', windowTitle: 'Draft', start: '2026-09-02T09:00:00.000Z', end: '2026-09-02T09:15:00.000Z', durationMs: 900000, intervalIds: [7], evidenceCount: 1 }],
    tasksToResume: [{ taskKey: 'code::draft', taskName: 'Draft', app: 'Code', lastSeen: '2026-09-02T09:15:00.000Z', returns: 1, totalDurationMs: 900000, intervalIds: [7], evidenceCount: 1 }],
    standupDraft: { text: 'Worked on: Draft.', workedOn: [{ taskName: 'Draft' }], spentMostTimeIn: { app: 'Code', durationMs: 900000 } },
    frictionSummary: [{ insightId: 'switch-1', title: 'Frequent app switching', summary: '5 foreground changes', signalLabel: 'Possible friction' }]
  });
  assert.match(get('myDayContent').innerHTML, /STANDUP DRAFT/);
  assert.match(get('myDayContent').innerHTML, /TODAY’S WORK JOURNAL/);
  assert.match(get('myDayContent').innerHTML, /TASKS TO RESUME/);
  assert.match(get('myDayContent').innerHTML, /PERSONAL FRICTION SUMMARY/);
  assert.match(get('myDayContent').innerHTML, /IN PROGRESS/);
  assert.match(get('myDayContent').innerHTML, /Frequent app switching/);
  assert.equal(get('myDayDate').textContent, new Date('2026-09-02T00:00:00.000Z').toLocaleDateString([], { month: 'short', day: 'numeric' }));
});

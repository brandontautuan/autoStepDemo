const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { JsFallbackActivityState } = require('../main');
const { SqliteStore } = require('../sqlite-store');
const { generateInsights } = require('../insights');

const window = (appName, windowTitle, processId, processName = appName, executablePath = '') => ({
  appName, windowTitle, title: windowTitle, processId, processName, executablePath, isForeground: true
});

const time = (seconds) => new Date(`2026-09-02T10:00:${String(seconds).padStart(2, '0')}.000Z`);

test('JS fallback emits a completed interval when the foreground identity changes', () => {
  const state = new JsFallbackActivityState(() => time(0));
  assert.deepEqual(state.update([window('Code', 'Draft', 10)], time(0)), []);
  assert.deepEqual(state.update([window('Safari', 'Docs', 20, 'Safari', '/Applications/Safari.app')], time(12)), [{
    start: time(0).toISOString(),
    end: time(12).toISOString(),
    durationMs: 12000,
    app: 'Code',
    windowTitle: 'Draft',
    process: { id: 10, name: 'Code', path: '' },
    source: 'js-fallback'
  }]);
  assert.deepEqual(state.update([window('Safari', 'Docs', 20, 'Safari', '/Applications/Safari.app')], time(24)), []);
});

test('JS fallback treats title, process changes, and no foreground as boundaries', () => {
  const state = new JsFallbackActivityState();
  state.update([window('Code', 'Draft', 10)], time(0));
  const titleChange = state.update([window('Code', 'Other file', 10)], time(5));
  assert.equal(titleChange[0].durationMs, 5000);
  const processChange = state.update([window('Code', 'Other file', 11, 'Code', '/Applications/Code.app')], time(9));
  assert.equal(processChange[0].durationMs, 4000);
  const foregroundLost = state.update([], time(14));
  assert.equal(foregroundLost[0].durationMs, 5000);
  assert.deepEqual(state.flush(time(20)), []);
});

test('JS fallback flush closes the active interval exactly once', () => {
  const state = new JsFallbackActivityState();
  state.update([window('Terminal', 'Shell', 30)], time(0));
  const events = state.flush(time(7));
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 7000);
  assert.deepEqual(state.flush(time(8)), []);
});

test('JS fallback intervals persist through the normal store and feed summaries and insights', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'js-fallback-store-'));
  const state = new JsFallbackActivityState();
  state.update([window('Code', 'Draft', 10)], time(0));
  const events = [
    ...state.update([window('Safari', 'Docs', 20)], time(10)),
    ...state.update([window('Terminal', 'npm test', 30)], time(20)),
    ...state.flush(time(30))
  ];
  const store = new SqliteStore(directory).initialize();
  store.enqueueActivity(events);
  store.flush();

  const activity = store.getActivity();
  assert.equal(activity.length, 3);
  assert.ok(activity.every((event) => event.source === 'js-fallback'));
  assert.deepEqual(store.getSummary().activityCount, 3);
  assert.equal(store.getSummary().switchCount, 2);
  assert.equal(generateInsights(activity, { thresholds: { switchBurstCount: 1, longFocusMs: Number.MAX_SAFE_INTEGER } })
    .filter((insight) => insight.type === 'context_switch_burst').length, 1);

  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

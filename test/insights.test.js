const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateInsights, normalizeActivity, estimatedCost } = require('../insights');
const { readFeedback, setFeedback } = require('../feedback');

const record = (start, app, title, durationMs, extra = {}) => ({
  start: new Date(start).toISOString(),
  end: new Date(new Date(start).getTime() + durationMs).toISOString(),
  app, windowTitle: title, durationMs, ...extra
});

test('normalizes legacy and canonical records and sorts malformed data out', () => {
  const result = normalizeActivity([
    { timestamp: '2026-08-30T10:00:10Z', appName: 'Safari', title: 'Page', duration: 2 },
    { start: '2026-08-30T10:00:00Z', end: '2026-08-30T10:00:05Z', app: 'Code', windowTitle: 'Draft', durationMs: 5000, process: { id: 2 } },
    { app: 'bad', durationMs: 10 }
  ]);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.app), ['Code', 'Safari']);
  assert.equal(result[1].durationMs, 2000);
  assert.equal(result[0].process.id, 2);
});

test('detects long focus intervals and calculates cost', () => {
  const insights = generateInsights([record('2026-08-30T10:00:00Z', 'Code', 'Draft', 120000)], {
    hourlyRate: 90, thresholds: { longFocusMs: 60000 }
  });
  const insight = insights.find((item) => item.type === 'long_focus_interval');
  assert.equal(insight.metrics.durationMs, 120000);
  assert.equal(insight.metrics.estimatedCost, 3);
  assert.equal(insight.evidence.length, 1);
});

test('detects a context switch burst with all evidence intervals', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = ['Code', 'Safari', 'Terminal', 'Code'].map((app, index) => record(start + index * 60000, app, app, 30000));
  const insights = generateInsights(activity, { thresholds: { switchBurstCount: 2, switchBurstWindowMs: 10 * 60000 } });
  const insight = insights.find((item) => item.type === 'context_switch_burst');
  assert.equal(insight.metrics.switchCount, 3);
  assert.equal(insight.evidence.length, 4);
});

test('detects repeated revisits to the same app and title', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = [0, 2, 4].map((minutes) => record(start + minutes * 60000, 'Support', 'Ticket 123', 30000));
  const insight = generateInsights(activity, { thresholds: { revisitCount: 3, revisitWindowMs: 10 * 60000 } }).find((item) => item.type === 'repeated_revisit');
  assert.equal(insight.metrics.revisitCount, 2);
  assert.equal(insight.evidence.length, 3);
});

test('handles empty and malformed activity safely', () => {
  assert.deepEqual(generateInsights(null), []);
  assert.deepEqual(generateInsights([{ app: 'Unknown', durationMs: 'nope' }, {}]), []);
  assert.equal(estimatedCost(3600000, 60), 60);
});

test('persists and reloads insight feedback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-feedback-'));
  const file = path.join(directory, 'feedback.json');
  setFeedback(file, 'insight-1', 'correct', '2026-08-30T10:00:00Z');
  assert.deepEqual(readFeedback(file), { 'insight-1': { status: 'correct', updatedAt: '2026-08-30T10:00:00Z' } });
});

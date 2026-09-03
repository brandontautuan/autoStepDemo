const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generateInsights, normalizeActivity, confidenceLabel, applyFeedback } = require('../insights');
const { readFeedback, setFeedback } = require('../feedback');

const record = (start, app, title = app, durationMs = 30000, extra = {}) => ({
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

test('merges overlapping context-switch candidate windows into one explainable burst', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = ['Code', 'Safari', 'Terminal', 'Code', 'Safari', 'Terminal']
    .map((app, index) => record(start + index * 60000, app));
  const insights = generateInsights(activity, { thresholds: { switchBurstCount: 2, switchBurstWindowMs: 10 * 60000 } });
  const bursts = insights.filter((item) => item.type === 'context_switch_burst');
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0].title, 'Frequent app switching');
  assert.equal(bursts[0].metrics.foregroundChanges, 5);
  assert.match(bursts[0].summary, /^5 foreground changes in /);
  assert.equal(bursts[0].evidenceDetails.distinctApps.length, 3);
  assert.equal(bursts[0].evidence.length, 6);
});

test('keeps separate context-switch bursts when their candidate windows are far apart', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const firstBurst = ['Code', 'Safari', 'Terminal'].map((app, index) => record(start + index * 60000, app));
  const secondBurst = ['Code', 'Safari', 'Terminal'].map((app, index) => record(start + (60 + index) * 60000, app));
  const bursts = generateInsights([...firstBurst, ...secondBurst], { thresholds: { switchBurstCount: 2, switchBurstWindowMs: 10 * 60000 } })
    .filter((item) => item.type === 'context_switch_burst');
  assert.equal(bursts.length, 2);
});

test('long focus is a neutral work pattern, not high friction', () => {
  const insights = generateInsights([record('2026-08-30T10:00:00Z', 'Code', 'Draft', 120000)], { thresholds: { longFocusMs: 60000 } });
  const insight = insights.find((item) => item.type === 'long_focus_block');
  assert.equal(insight.title, 'Long focus block in Code — Draft');
  assert.equal(insight.category, 'work_pattern');
  assert.equal(insight.signalLabel, 'Work pattern');
  assert.equal(insight.metrics.durationMs, 120000);
});

test('three or more focus intervals in one app become one titled work pattern', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = [
    record(start, 'Visual Studio Code', 'README.md — autoStepDemo', 7 * 60000),
    record(start + 20 * 60000, 'Visual Studio Code', 'activity.json — autoStepDemo', 13 * 60000),
    record(start + 40 * 60000, 'Visual Studio Code', 'activity.json — autoStepDemo', 7 * 60000)
  ];
  const focus = generateInsights(activity, { thresholds: { longFocusMs: 5 * 60000, switchBurstCount: Number.MAX_SAFE_INTEGER } })
    .filter((item) => item.type === 'long_focus_block');
  assert.equal(focus.length, 1);
  assert.equal(focus[0].title, 'Focus blocks in Visual Studio Code');
  assert.equal(focus[0].metrics.focusBlockCount, 3);
  assert.match(focus[0].summary, /README\.md — autoStepDemo/);
  assert.equal(focus[0].evidence.length, 3);
});

test('repeated returns require interruptions between visits', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = [
    record(start, 'Support', 'Ticket 123'),
    record(start + 60000, 'Browser', 'Documentation'),
    record(start + 2 * 60000, 'Support', 'Ticket 123'),
    record(start + 3 * 60000, 'Terminal', 'npm test'),
    record(start + 4 * 60000, 'Support', 'Ticket 123')
  ];
  const insight = generateInsights(activity, { thresholds: { revisitCount: 3, revisitWindowMs: 10 * 60000 } }).find((item) => item.type === 'repeated_revisit');
  assert.equal(insight.metrics.revisitCount, 2);
  assert.equal(insight.metrics.interruptionCount, 2);
  assert.equal(insight.evidence.length, 5);
});

test('confidence uses explainable text labels rather than percentages', () => {
  assert.equal(confidenceLabel(0.81), 'Strong evidence');
  assert.equal(confidenceLabel(0.65), 'Moderate evidence');
  assert.equal(confidenceLabel(0.59), 'Weak signal');
  const insight = generateInsights([record('2026-08-30T10:00:00Z', 'Code', 'Draft', 120000)], { thresholds: { longFocusMs: 60000 } })[0];
  assert.doesNotMatch(insight.confidenceLabel, /%/);
});

test('switch count means foreground changes, not distinct apps', () => {
  const start = Date.parse('2026-08-30T10:00:00Z');
  const activity = ['Code', 'Safari', 'Code', 'Safari'].map((app, index) => record(start + index * 60000, app));
  const insight = generateInsights(activity, { thresholds: { switchBurstCount: 2, switchBurstWindowMs: 10 * 60000 } })
    .find((item) => item.type === 'context_switch_burst');
  assert.equal(insight.metrics.foregroundChanges, 3);
  assert.equal(insight.metrics.distinctApps, 2);
});

test('feedback persists every status, recovers from corruption, and lowers ignored signals in ranking', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-feedback-'));
  const file = path.join(directory, 'feedback.json');
  ['correct', 'expected', 'incorrect', 'ignore'].forEach((status, index) => {
    setFeedback(file, `insight-${index + 1}`, status, '2026-08-30T10:00:00Z');
  });
  const feedback = readFeedback(file);
  assert.equal(feedback['insight-1'].status, 'correct');
  assert.equal(feedback['insight-2'].status, 'expected');
  assert.equal(feedback['insight-3'].status, 'incorrect');
  assert.equal(feedback['insight-4'].status, 'ignore');
  const ranked = applyFeedback([
    { id: 'insight-4', rank: 300, confidence: 0.9, signalLabel: 'Needs review' },
    { id: 'unreviewed', rank: 200, confidence: 0.8, signalLabel: 'Possible friction' }
  ], feedback);
  assert.deepEqual(ranked.map((item) => item.id), ['unreviewed', 'insight-4']);
  assert.equal(ranked[1].signalLabel, 'Dismissed');
  assert.equal(ranked[1].status, 'ignore');
  const expected = applyFeedback([{ id: 'insight-2', rank: 300, confidence: 0.9, signalLabel: 'Possible friction' }], feedback)[0];
  assert.equal(expected.signalLabel, 'Possible friction');
  assert.equal(expected.status, 'expected');
  assert.equal(expected.rank, -200);
  fs.writeFileSync(file, '{broken json');
  assert.deepEqual(readFeedback(file), {});
  fs.rmSync(directory, { recursive: true, force: true });
});

test('handles empty and malformed activity safely', () => {
  assert.deepEqual(generateInsights(null), []);
  assert.deepEqual(generateInsights([
    { app: 'Unknown', durationMs: 'nope' },
    { start: '2026-08-30T10:05:00Z', end: '2026-08-30T10:00:00Z', app: 'Code', durationMs: 5000 },
    {}
  ]), []);
});

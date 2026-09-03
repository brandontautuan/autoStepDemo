const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPersonalDashboard, buildWorkJournal, activeFriction, taskKey } = require('../personal-dashboard');

const now = new Date(2026, 8, 2, 12, 0, 0);
const at = (hour, minute) => new Date(2026, 8, 2, hour, minute, 0).toISOString();
const interval = (hour, minute, durationMs, app, windowTitle) => ({
  id: `${hour}:${minute}:${app}:${windowTitle}`,
  start: at(hour, minute), end: new Date(new Date(at(hour, minute)).getTime() + durationMs).toISOString(),
  durationMs, app, windowTitle
});

const activity = [
  interval(9, 0, 10 * 60 * 1000, 'Code', 'Draft proposal'),
  interval(9, 11, 5 * 60 * 1000, 'Code', 'Draft proposal'),
  interval(9, 20, 5 * 60 * 1000, 'Terminal', 'npm test'),
  interval(9, 30, 4 * 60 * 1000, 'Code', 'Draft proposal'),
  interval(9, 40, 3 * 60 * 1000, 'Browser', 'Issue 42')
];

test('work journal merges adjacent matching activity into readable blocks', () => {
  const dashboard = buildPersonalDashboard({ activity, now });
  assert.equal(dashboard.journal.length, 4);
  const first = dashboard.journal[0];
  assert.equal(first.taskKey, 'code::draft proposal');
  assert.equal(first.taskName, 'Draft proposal');
  assert.equal(first.start, at(9, 0));
  assert.equal(first.end, at(9, 16));
  assert.equal(first.durationMs, 15 * 60 * 1000);
  assert.equal(first.intervalCount, 2);
  assert.deepEqual(first.intervalIds, [activity[0].id, activity[1].id]);
  assert.equal(first.evidenceCount, 2);
  assert.equal(buildWorkJournal([]).length, 0);
});

test('tasks to resume use repeated normalized app/title blocks', () => {
  const dashboard = buildPersonalDashboard({ activity, now });
  const task = dashboard.tasksToResume[0];
  assert.equal(task.taskKey, 'code::draft proposal');
  assert.equal(task.taskName, 'Draft proposal');
  assert.equal(task.lastSeen, at(9, 34));
  assert.equal(task.returns, 1);
  assert.equal(task.totalDurationMs, 19 * 60 * 1000);
  assert.equal(task.evidenceCount, 3);
  assert.deepEqual(task.intervalIds, [activity[0].id, activity[1].id, activity[3].id]);
});

test('standup draft summarizes normal activity deterministically', () => {
  const dashboard = buildPersonalDashboard({ activity, now, insights: [{
    id: 'friction-1', category: 'friction', rank: 200, confidence: 0.8,
    title: 'Frequent app switching', summary: '5 foreground changes', signalLabel: 'Possible friction', confidenceLabel: 'Strong evidence'
  }] });
  assert.equal(dashboard.standupDraft.workedOn[0].taskName, 'Draft proposal');
  assert.deepEqual(dashboard.standupDraft.spentMostTimeIn, { app: 'Code', durationMs: 19 * 60 * 1000 });
  assert.equal(dashboard.standupDraft.possibleBlockers[0].title, 'Frequent app switching');
  assert.equal(dashboard.standupDraft.tasksToResume[0].taskName, 'Draft proposal');
  assert.match(dashboard.standupDraft.text, /Worked on:/);
});

test('standup draft has a useful empty state', () => {
  const dashboard = buildPersonalDashboard({ activity: [], insights: [], now });
  assert.deepEqual(dashboard.journal, []);
  assert.deepEqual(dashboard.tasksToResume, []);
  assert.equal(dashboard.standupDraft.headline, 'No completed activity blocks for today yet.');
  assert.deepEqual(dashboard.frictionSummary, []);
});

test('dismissed insights are excluded from the personal friction summary', () => {
  const friction = activeFriction([
    { id: 'active', category: 'friction', rank: 300, confidence: 0.9, title: 'Active signal', summary: 'Active', signalLabel: 'Needs review' },
    { id: 'ignored', category: 'friction', rank: 999, confidence: 1, title: 'Ignored signal', summary: 'Ignored', signalLabel: 'Dismissed', status: 'ignore' },
    { id: 'pattern', category: 'work_pattern', rank: 50, confidence: 0.7, title: 'Focus block', summary: 'Focus', signalLabel: 'Work pattern' }
  ]);
  assert.deepEqual(friction.map((item) => item.insightId), ['active']);
});

test('canonical task keys group casing and formatting variations consistently', () => {
  const first = interval(9, 0, 2 * 60 * 1000, 'Visual Studio Code', 'Draft   Proposal');
  const second = interval(9, 10, 2 * 60 * 1000, 'visual studio code', 'draft proposal');
  assert.equal(taskKey({ normalizedApp: first.app, normalizedTitle: first.windowTitle }), taskKey({ normalizedApp: second.app, normalizedTitle: second.windowTitle }));
  const dashboard = buildPersonalDashboard({ activity: [first, interval(9, 5, 2 * 60 * 1000, 'Terminal', 'npm test'), second], now });
  assert.equal(dashboard.tasksToResume.length, 1);
  assert.equal(dashboard.tasksToResume[0].taskKey, 'visual studio code::draft proposal');
});

test('an interval crossing midnight contributes only its overlap to the selected local day', () => {
  const midnight = new Date(2026, 8, 2, 0, 0, 0);
  const start = new Date(midnight.getTime() - 5 * 60 * 1000);
  const end = new Date(midnight.getTime() + 5 * 60 * 1000);
  const crossing = { id: 'crossing', start: start.toISOString(), end: end.toISOString(), durationMs: 10 * 60 * 1000, app: 'Terminal', windowTitle: 'Late work' };
  const dashboard = buildPersonalDashboard({ activity: [crossing], now: new Date(2026, 8, 2, 12, 0, 0) });
  assert.equal(dashboard.journal.length, 1);
  assert.equal(dashboard.journal[0].start, midnight.toISOString());
  assert.equal(dashboard.journal[0].durationMs, 5 * 60 * 1000);
  assert.deepEqual(dashboard.journal[0].intervalIds, ['crossing']);
});

test('dashboard provenance IDs point to supplied activity intervals', () => {
  const dashboard = buildPersonalDashboard({ activity, now });
  const suppliedIds = new Set(activity.map((record) => record.id));
  dashboard.journal.forEach((block) => block.intervalIds.forEach((id) => assert.ok(suppliedIds.has(id))));
  dashboard.tasksToResume.forEach((task) => task.intervalIds.forEach((id) => assert.ok(suppliedIds.has(id))));
  assert.equal(dashboard.frictionSummary.length, 0);
});

test('current work is explicitly live and updates independently of completed journal blocks', () => {
  const currentWork = {
    start: at(11, 50), end: at(12, 0), durationMs: 10 * 60 * 1000,
    app: 'Visual Studio Code', windowTitle: 'personal-dashboard.js — autoStepDemo', source: 'live'
  };
  const dashboard = buildPersonalDashboard({ activity: [], currentWork, now });
  assert.equal(dashboard.isLive, true);
  assert.equal(dashboard.currentWork.taskName, 'personal-dashboard.js — autoStepDemo');
  assert.equal(dashboard.currentWork.durationMs, 10 * 60 * 1000);
  assert.deepEqual(dashboard.journal, []);
});

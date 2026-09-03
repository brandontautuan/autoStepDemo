const { normalizeActivity } = require('./insights');

const JOURNAL_MERGE_GAP_MS = 2 * 60 * 1000;

function taskName(record) {
  return record.windowTitle || record.app || 'Untitled task';
}

function canonicalPart(value, fallback = '') {
  return String(value || fallback).trim().replace(/\s+/g, ' ').toLowerCase();
}

function taskKey(record = {}) {
  return `${canonicalPart(record.normalizedApp, record.app || 'Unknown app')}::${canonicalPart(record.normalizedTitle, record.windowTitle || '')}`;
}

function localDayRange(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('A valid date is required for the personal dashboard');
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    startMs: start.getTime(),
    endMs: end.getTime()
  };
}

function recordsForRange(activity, range) {
  return normalizeActivity(activity).reduce((records, record) => {
    if (record.endMs <= range.startMs || record.startMs >= range.endMs) return records;
    const startMs = Math.max(record.startMs, range.startMs);
    const endMs = Math.min(record.endMs, range.endMs);
    if (endMs <= startMs) return records;
    records.push({
      ...record,
      taskKey: taskKey(record),
      start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(),
      startMs, endMs, durationMs: endMs - startMs
    });
    return records;
  }, []);
}

function buildWorkJournal(records, mergeGapMs = JOURNAL_MERGE_GAP_MS) {
  return records.reduce((journal, record) => {
    const previous = journal[journal.length - 1];
    const recordTaskKey = record.taskKey || taskKey(record);
    const sameTask = previous && previous.taskKey === recordTaskKey;
    const nearby = previous && record.startMs - previous.endMs <= mergeGapMs;
    if (sameTask && nearby) {
      previous.endMs = Math.max(previous.endMs, record.endMs);
      previous.end = new Date(previous.endMs).toISOString();
      previous.durationMs += record.durationMs;
      previous.intervalCount += 1;
      previous.intervalIds.push(record.intervalId);
      previous.evidenceCount += 1;
      return journal;
    }
    journal.push({
      journalBlockId: `journal:${record.startMs}:${recordTaskKey}`,
      taskKey: recordTaskKey, taskName: taskName(record), app: record.app, windowTitle: record.windowTitle,
      start: record.start, end: record.end, startMs: record.startMs, endMs: record.endMs,
      durationMs: record.durationMs, intervalCount: 1, intervalIds: [record.intervalId], evidenceCount: 1
    });
    return journal;
  }, []).map(({ startMs, endMs, ...block }) => block);
}

function tasksToResume(journal) {
  const grouped = new Map();
  journal.forEach((block) => {
    const task = grouped.get(block.taskKey) || {
      taskKey: block.taskKey, taskName: block.taskName, app: block.app, windowTitle: block.windowTitle,
      lastSeen: block.end, returns: 0, totalDurationMs: 0, blockCount: 0, intervalIds: [], journalBlockIds: []
    };
    if (task.blockCount > 0) task.returns += 1;
    if (Date.parse(block.end) > Date.parse(task.lastSeen)) task.lastSeen = block.end;
    task.totalDurationMs += block.durationMs;
    task.blockCount += 1;
    task.intervalIds.push(...block.intervalIds);
    task.journalBlockIds.push(block.journalBlockId);
    grouped.set(block.taskKey, task);
  });
  return [...grouped.values()]
    .filter((task) => task.returns > 0)
    .sort((a, b) => b.returns - a.returns || Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || b.totalDurationMs - a.totalDurationMs)
    .map(({ blockCount, ...task }) => ({ ...task, intervalIds: [...new Set(task.intervalIds)], evidenceCount: task.intervalIds.length }));
}

function workedOn(journal) {
  const tasks = new Map();
  journal.forEach((block) => {
    const item = tasks.get(block.taskKey) || { taskKey: block.taskKey, taskName: block.taskName, app: block.app, durationMs: 0 };
    item.durationMs += block.durationMs;
    tasks.set(block.taskKey, item);
  });
  return [...tasks.values()].sort((a, b) => b.durationMs - a.durationMs || a.taskName.localeCompare(b.taskName)).slice(0, 3);
}

function mostTimeIn(journal) {
  const apps = new Map();
  journal.forEach((block) => {
    const item = apps.get(block.app) || { app: block.app, durationMs: 0 };
    item.durationMs += block.durationMs;
    apps.set(block.app, item);
  });
  return [...apps.values()].sort((a, b) => b.durationMs - a.durationMs || a.app.localeCompare(b.app))[0] || null;
}

function activeFriction(insights) {
  if (!Array.isArray(insights)) return [];
  return insights
    .filter((insight) => insight && insight.category === 'friction' && insight.status !== 'ignore' && insight.signalLabel !== 'Dismissed')
    .sort((a, b) => b.rank - a.rank || b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, 3)
    .map((insight) => ({
      insightId: insight.id, title: insight.title, summary: insight.summary,
      signalLabel: insight.signalLabel, confidenceLabel: insight.confidenceLabel, status: insight.status || null
    }));
}

function visibleCurrentWork(currentWork, range) {
  if (!currentWork) return null;
  const record = recordsForRange([currentWork], range)[0];
  if (!record) return null;
  return {
    taskKey: record.taskKey,
    taskName: taskName(record),
    app: record.app,
    windowTitle: record.windowTitle,
    start: record.start,
    end: record.end,
    durationMs: record.durationMs,
    isLive: true
  };
}

function buildStandupDraft(journal, resume, friction) {
  const tasks = workedOn(journal);
  const topApp = mostTimeIn(journal);
  if (!journal.length) {
    return {
      headline: 'No completed activity blocks for today yet.', workedOn: [], spentMostTimeIn: null,
      possibleBlockers: [], tasksToResume: [], text: 'No completed activity has been captured today yet.'
    };
  }
  const text = [
    `Worked on: ${tasks.map((task) => task.taskName).join(', ') || 'captured activity'}.`,
    topApp ? `Spent the most time in ${topApp.app}.` : null,
    friction.length ? `Possible friction: ${friction.map((item) => item.title).join('; ')}.` : 'No active friction signals stood out.',
    resume.length ? `Tasks to resume: ${resume.map((task) => task.taskName).join(', ')}.` : 'No repeated tasks stood out to resume.'
  ].filter(Boolean).join(' ');
  return {
    headline: 'A deterministic draft from today’s captured activity.', workedOn: tasks, spentMostTimeIn: topApp,
    possibleBlockers: friction, tasksToResume: resume.slice(0, 3), text
  };
}

function buildPersonalDashboard({ activity = [], insights = [], currentWork = null, now = new Date() } = {}) {
  const range = localDayRange(now);
  const records = recordsForRange(activity, range);
  const journal = buildWorkJournal(records);
  const resume = tasksToResume(journal);
  const frictionSummary = activeFriction(insights);
  return {
    generatedAt: new Date(now).toISOString(),
    range: { start: range.start, end: range.end, timezone: range.timezone },
    isLive: Boolean(currentWork),
    currentWork: visibleCurrentWork(currentWork, range),
    journal, tasksToResume: resume,
    standupDraft: buildStandupDraft(journal, resume, frictionSummary), frictionSummary
  };
}

module.exports = {
  JOURNAL_MERGE_GAP_MS, taskKey, localDayRange, recordsForRange, buildWorkJournal,
  tasksToResume, activeFriction, visibleCurrentWork, buildStandupDraft, buildPersonalDashboard
};

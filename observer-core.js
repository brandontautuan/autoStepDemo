function cleanWindow(window = {}) {
  return {
    appName: window.appName || 'Unknown app',
    processName: window.processName || '',
    title: window.title || '',
    windowTitle: window.windowTitle || window.title || '',
    processId: Number(window.processId) || null,
    executablePath: window.executablePath || '',
    isForeground: Boolean(window.isForeground),
    isVisible: window.isVisible !== false,
    isMinimized: Boolean(window.isMinimized)
  };
}

function normalizeInterval(intervalMs) {
  return Math.max(2000, Number(intervalMs) || 10000);
}

function windowSignature(windows) {
  return JSON.stringify(windows.map(({ isForeground, ...item }) => item));
}

function hasWindowSetChanged(previousSnapshot, windows) {
  return !previousSnapshot || windowSignature(windows) !== windowSignature(previousSnapshot.windows || []);
}

function readableActivityEvent(event = {}) {
  const end = typeof event.end === 'string'
    ? event.end
    : (typeof event.timestamp === 'number' ? new Date(event.timestamp).toISOString() : event.timestamp);
  const durationMs = event.duration != null ? Number(event.duration) * 1000 : Number(event.durationMs) || 0;
  const endDate = new Date(end);
  return {
    action: event.action ?? null,
    app: event.app || event.appName || 'Unknown app',
    domain: event.domain ?? null,
    start: event.start || (Number.isNaN(endDate.getTime()) ? end : new Date(endDate.getTime() - durationMs).toISOString()),
    end,
    duration: Math.max(0, durationMs / 1000),
    windowTitle: event.windowTitle || event.title || '',
    path: event.path || event.executablePath || '',
    processId: Number(event.processId) || null,
    processName: event.processName || ''
  };
}

function summarizeActivity(records) {
  const apps = new Map();
  let totalTrackedMs = 0;
  let switchCount = 0;
  records.forEach((record, index) => {
    const appName = record.app || record.appName || 'Unknown app';
    const durationMs = Math.max(0, record.duration != null ? Number(record.duration) * 1000 : Number(record.durationMs) || 0);
    totalTrackedMs += durationMs;
    const previousApp = records[index - 1] && (records[index - 1].app || records[index - 1].appName || 'Unknown app');
    if (index > 0 && appName !== previousApp) switchCount += 1;
    const summary = apps.get(appName) || { appName, totalDurationMs: 0, sessions: 0 };
    summary.totalDurationMs += durationMs;
    summary.sessions += 1;
    apps.set(appName, summary);
  });
  return {
    totalTrackedMs,
    activityCount: records.length,
    switchCount,
    apps: [...apps.values()].sort((a, b) => b.totalDurationMs - a.totalDurationMs || a.appName.localeCompare(b.appName))
  };
}

module.exports = { cleanWindow, normalizeInterval, windowSignature, hasWindowSetChanged, readableActivityEvent, summarizeActivity };

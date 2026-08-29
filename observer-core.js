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
  return {
    timestamp: typeof event.timestamp === 'number'
      ? new Date(event.timestamp).toISOString()
      : event.timestamp,
    windowTitle: event.windowTitle || '',
    appName: event.appName || 'Unknown app',
    path: event.path || event.executablePath || '',
    processId: Number(event.processId) || null,
    processName: event.processName || '',
    durationMs: Number(event.durationMs) || 0
  };
}

function summarizeActivity(records) {
  const apps = new Map();
  let totalTrackedMs = 0;
  let switchCount = 0;
  records.forEach((record, index) => {
    const appName = record.appName || 'Unknown app';
    const durationMs = Math.max(0, Number(record.durationMs) || 0);
    totalTrackedMs += durationMs;
    if (index > 0 && appName !== (records[index - 1].appName || 'Unknown app')) switchCount += 1;
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

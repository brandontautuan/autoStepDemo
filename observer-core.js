function cleanWindow(window) {
  return {
    appName: window.appName || 'Unknown app',
    processName: window.processName || '',
    title: window.title || '',
    processId: Number(window.processId) || null,
    executablePath: window.executablePath || '',
    isForeground: Boolean(window.isForeground)
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

module.exports = { cleanWindow, normalizeInterval, windowSignature, hasWindowSetChanged };

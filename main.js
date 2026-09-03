const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { cleanWindow, normalizeInterval, hasWindowSetChanged } = require('./observer-core');
const { SqliteStore } = require('./sqlite-store');
const { generateInsights, applyFeedback } = require('./insights');
const { buildPersonalDashboard } = require('./personal-dashboard');
const { readFeedback, setFeedback } = require('./feedback');
const { createLocalApiHandler } = require('./local-api');

let mainWindow;
let observerTimer;
let rustCollector;
let rustBuffer = '';
let rustPending = [];
let captureInFlight = false;
let observerRunId = 0;
let apiServer;
let dataStore;
let quitFinalizationStarted = false;
let observerState = {
  running: false,
  intervalMs: 10000,
  lastSnapshot: null,
  collectorMode: null,
  collectorWarning: null,
  collectorDegraded: false,
  lastCaptureError: null,
  lastSuccessfulCaptureAt: null
};

const hasSingleInstanceLock = !process.versions.electron || app.requestSingleInstanceLock();

class JsFallbackActivityState {
  constructor(now = () => new Date()) {
    this.now = now;
    this.activeWindow = null;
    this.activeSince = null;
  }

  sameWindow(previous, next) {
    if (!previous || !next) return false;
    return previous.appName === next.appName
      && (previous.windowTitle || previous.title || '') === (next.windowTitle || next.title || '')
      && (Number(previous.processId) || null) === (Number(next.processId) || null);
  }

  eventFor(window, start, end, source = 'js-fallback') {
    return {
      start: start.toISOString(),
      end: end.toISOString(),
      durationMs: Math.max(0, end.getTime() - start.getTime()),
      app: window.appName || 'Unknown app',
      windowTitle: window.windowTitle || window.title || '',
      process: {
        id: Number(window.processId) || null,
        name: window.processName || '',
        path: window.executablePath || window.path || ''
      },
      source
    };
  }

  update(windows, now = this.now()) {
    const nextWindow = (windows || []).find((window) => window.isForeground) || null;
    if (this.sameWindow(this.activeWindow, nextWindow)
      || (!this.activeWindow && !nextWindow)) return [];

    const events = [];
    if (this.activeWindow && this.activeSince) {
      events.push(this.eventFor(this.activeWindow, this.activeSince, now));
    }
    this.activeWindow = nextWindow;
    this.activeSince = nextWindow ? now : null;
    return events;
  }

  flush(now = this.now()) {
    if (!this.activeWindow || !this.activeSince) return [];
    const event = this.eventFor(this.activeWindow, this.activeSince, now);
    this.activeWindow = null;
    this.activeSince = null;
    return [event];
  }

  current(now = this.now()) {
    if (!this.activeWindow || !this.activeSince) return null;
    return this.eventFor(this.activeWindow, this.activeSince, now, 'live');
  }

  clear() {
    this.activeWindow = null;
    this.activeSince = null;
  }
}

const jsFallbackActivity = new JsFallbackActivityState();
const liveForeground = new JsFallbackActivityState();

function dataPaths() {
  // Keep `npm start` data visible in the repository. Packaged apps use the
  // writable userData directory because the application bundle is read-only.
  const directory = process.env.WINDOW_OBSERVER_DATA_DIR || (app.isPackaged
    ? path.join(app.getPath('userData'), 'observer-data')
    : path.join(__dirname, 'observer-data'));
  fs.mkdirSync(directory, { recursive: true });
  return {
    directory,
    latest: path.join(directory, 'latest.json'),
    history: path.join(directory, 'history.json'),
    activity: path.join(directory, 'activity.json'),
    database: path.join(directory, 'observer.sqlite'),
    feedback: path.join(directory, 'feedback.json')
  };
}

function getDataStore() {
  if (!dataStore) {
    dataStore = new SqliteStore(dataPaths().directory, {
      onFlush: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('snapshot-updated', observerState.lastSnapshot);
        }
      }
    }).initialize();
  }
  return dataStore;
}

function initializeDataStore() {
  const store = getDataStore();
  observerState.lastSnapshot = store.getLatestSnapshot({ flush: false });
  return store;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function insightsWithFeedback() {
  const paths = dataPaths();
  const activity = getDataStore().getActivity();
  const feedback = readFeedback(paths.feedback);
  return applyFeedback(generateInsights(activity), feedback);
}

function personalDashboard() {
  const currentWork = observerState.running && !observerState.lastCaptureError ? liveForeground.current() : null;
  return buildPersonalDashboard({ activity: getDataStore().getActivity(), insights: insightsWithFeedback(), currentWork });
}

function persistInsightFeedback(id, status) {
  const paths = dataPaths();
  return setFeedback(paths.feedback, id, status);
}

function currentFromLatest(latest) {
  const windows = Array.isArray(latest.windows) ? latest.windows : [];
  const current = windows.find((window) => window.isForeground) || null;
  return {
    capturedAt: latest.timestamp || null,
    currentWindow: current ? {
      appName: current.appName || '',
      windowTitle: current.windowTitle || current.title || '',
      path: current.path || current.executablePath || '',
      processId: Number(current.processId) || null,
      processName: current.processName || ''
    } : null
  };
}

function createApiHandler() {
  return createLocalApiHandler({
    getActivity: () => getDataStore().getActivity(),
    getLatestSnapshot: () => getDataStore().getLatestSnapshot(),
    getSummary: () => getDataStore().getSummary(),
    getInsights: insightsWithFeedback,
    getPersonalDashboard: personalDashboard,
    saveFeedback: persistInsightFeedback,
    currentFromLatest
  });
}

function startApiServer() {
  const port = Number(process.env.WINDOW_OBSERVER_API_PORT) || 47821;
  apiServer = http.createServer(createApiHandler());
  apiServer.on('error', (error) => console.error(`Local API server error: ${error.message}`));
  apiServer.listen(port, '127.0.0.1', () => console.log(`Local API listening at http://127.0.0.1:${port}`));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function jsWindowsOpenApps() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const script = `
        const systemEvents = Application('System Events');
        const rows = [];
        for (const process of systemEvents.processes()) {
          try {
            const appName = process.name();
            const processId = process.unixId();
            if (processId === ${process.pid}) continue;
            const isVisible = Boolean(process.visible());
            const isForeground = Boolean(process.frontmost());
            if (!isVisible) continue;
            for (const window of process.windows()) {
              try {
                const title = window.name() || '';
                rows.push({ appName, processName: appName, title, windowTitle: title, processId, executablePath: '', isForeground, isVisible, isMinimized: false });
              } catch (_) {}
            }
          } catch (_) {}
        }
        JSON.stringify({ processCount: systemEvents.processes().length, windows: rows });
      `;
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || `${error.message}. Grant Accessibility access to this app in System Settings.`));
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : { processCount: 0, windows: [] };
          if (!parsed.processCount) return reject(new Error('macOS returned no accessible processes. Grant Accessibility access to Electron or Window Observer in System Settings → Privacy & Security → Accessibility.'));
          resolve(parsed.windows.map(cleanWindow));
        } catch (parseError) { reject(parseError); }
      });
      return;
    }
    if (process.platform !== 'win32') {
      resolve([cleanWindow({ appName: 'Demo mode', processName: process.platform, title: 'Run this app on Windows to observe windows', processId: process.pid, isForeground: true })]);
      return;
    }

    const script = [
      'Add-Type @"',
      'using System; using System.Text; using System.Runtime.InteropServices;',
      'public static class WindowObserverNative {',
      '  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);',
      '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);',
      '  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);',
      '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);',
      '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);',
      '}',
      '"@',
      `$observerPid = ${process.pid}`,
      '$rows = @()',
      '[WindowObserverNative]::EnumWindows({ param($handle, $unused); $pid = 0; [WindowObserverNative]::GetWindowThreadProcessId($handle, [ref]$pid) | Out-Null; if ($pid -eq $observerPid) { return $true }; $titleBuffer = New-Object Text.StringBuilder 1024; [WindowObserverNative]::GetWindowText($handle, $titleBuffer, 1024) | Out-Null; $process = Get-Process -Id $pid -ErrorAction SilentlyContinue; if ($null -ne $process) { $rows += [PSCustomObject]@{ appName=if ($process.Description) { $process.Description } else { $process.ProcessName }; processName=$process.ProcessName; title=$titleBuffer.ToString(); windowTitle=$titleBuffer.ToString(); processId=$pid; executablePath=$process.Path; isForeground=$false; isVisible=[WindowObserverNative]::IsWindowVisible($handle); isMinimized=[WindowObserverNative]::IsIconic($handle) } }; return $true }, [IntPtr]::Zero) | Out-Null',
      '$rows | ConvertTo-Json -Depth 3 -Compress'
    ].join('\n');

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        const windows = parsed == null ? [] : (Array.isArray(parsed) ? parsed : [parsed]);
        resolve(windows.map(cleanWindow));
      } catch (parseError) { reject(parseError); }
    });
  });
}

function rustCollectorPath() {
  return process.env.WINDOW_OBSERVER_RUST_BINARY || path.join(__dirname, 'rust-collector', 'target', 'debug', process.platform === 'win32' ? 'window-observer-collector.exe' : 'window-observer-collector');
}

function rejectRustPending(error) {
  const pending = rustPending;
  rustPending = [];
  pending.forEach(({ reject }) => reject(error));
}

function ensureRustCollector() {
  if (rustCollector && !rustCollector.killed) return rustCollector;
  rustCollector = spawn(rustCollectorPath(), ['--exclude-pid', String(process.pid)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  rustBuffer = '';
  rustCollector.stdout.setEncoding('utf8');
  rustCollector.stdout.on('data', (chunk) => {
    rustBuffer += chunk;
    const lines = rustBuffer.split(/\r?\n/);
    rustBuffer = lines.pop() || '';
    for (const line of lines.filter(Boolean)) {
      const request = rustPending.shift();
      if (!request) continue;
      try {
        const response = JSON.parse(line);
        request.resolve({
          windows: (response.windows || []).map(cleanWindow),
          activityEvents: (response.activityEvents || []).map((event) => ({ ...event, source: 'rust-collector' }))
        });
      } catch (error) { request.reject(error); }
    }
  });
  rustCollector.stderr.setEncoding('utf8');
  rustCollector.stderr.on('data', (message) => console.error(`Rust collector: ${message.trim()}`));
  rustCollector.on('error', (error) => rejectRustPending(error));
  rustCollector.on('exit', (code, signal) => {
    rustCollector = null;
    rejectRustPending(new Error(`Rust collector exited (${code ?? signal})`));
  });
  return rustCollector;
}

function rustWindowsOpenApps() {
  return rustCollectorCommand('capture', true);
}

function rustCollectorCommand(command, startIfMissing = false) {
  const collector = startIfMissing ? ensureRustCollector() : rustCollector;
  if (!collector || collector.killed) return Promise.resolve({ windows: [], activityEvents: [] });
  return new Promise((resolve, reject) => {
    if (rustPending.length >= 4) {
      reject(new Error('Rust collector request buffer is full'));
      return;
    }
    rustPending.push({ resolve, reject });
    collector.stdin.write(`${command}\n`, (error) => {
      if (error) {
        const request = rustPending.pop();
        if (request) request.reject(error);
      }
    });
  });
}

function flushRustActivity() {
  return rustCollectorCommand('flush');
}

function jsFallbackResponse(windows, warning = null, degraded = false) {
  return {
    windows,
    activityEvents: jsFallbackActivity.update(windows, new Date()),
    collectorMode: 'js-fallback',
    collectorWarning: warning || 'Using the JavaScript fallback collector.',
    collectorDegraded: degraded
  };
}

function windowsOpenApps() {
  const collector = process.env.WINDOW_OBSERVER_COLLECTOR || (process.platform === 'darwin' ? 'rust' : 'js');
  if (collector !== 'rust') {
    return jsWindowsOpenApps().then((windows) => jsFallbackResponse(windows));
  }
  return rustWindowsOpenApps()
    .then((result) => ({ ...result, collectorMode: 'rust', collectorWarning: null, collectorDegraded: false }))
    .catch((error) => {
      const warning = `Rust collector unavailable; using JavaScript fallback: ${error.message}`;
      console.error(warning);
      return jsWindowsOpenApps().then((windows) => jsFallbackResponse(windows, warning, true));
    });
}

function openAccessibilitySettings() {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility').then(() => true);
}

function getMemoryUsage() {
  const processes = typeof app.getAppMetrics === 'function' ? app.getAppMetrics() : [];
  const processRows = processes.map((metric) => ({
    type: metric.type || 'unknown',
    pid: Number(metric.pid) || null,
    workingSetSizeKB: Number(metric.memory?.workingSetSize) || 0,
    privateBytesKB: Number(metric.memory?.privateBytes) || 0,
    cpuPercent: Number(metric.cpu?.percentCPUUsage) || 0
  }));
  return {
    capturedAt: new Date().toISOString(),
    totalWorkingSetKB: processRows.reduce((total, row) => total + row.workingSetSizeKB, 0),
    totalPrivateBytesKB: processRows.reduce((total, row) => total + row.privateBytesKB, 0),
    processes: processRows
  };
}

function askActivityAgent(prompt) {
  const question = String(prompt || '').trim();
  if (!question) return Promise.reject(new Error('Enter a question first.'));
  const python = process.env.WINDOW_OBSERVER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  return new Promise((resolve, reject) => {
    execFile(python, [path.join(__dirname, 'activity_agent.py'), '--ask', question], {
      cwd: __dirname, timeout: 60000, env: process.env, windowsHide: true, maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) return reject(new Error((stderr || stdout || error.message).trim()));
      resolve(stdout.trim());
    });
  });
}

async function captureSnapshot({ runId } = {}) {
  const timestamp = new Date().toISOString();
  let windows;
  let activityEvents = [];
  try {
    const result = await windowsOpenApps();
    windows = Array.isArray(result) ? result : result.windows;
    activityEvents = Array.isArray(result) ? [] : (result.activityEvents || []);
    observerState.collectorMode = Array.isArray(result) ? 'unknown' : result.collectorMode;
    observerState.collectorWarning = Array.isArray(result) ? null : result.collectorWarning;
    observerState.collectorDegraded = Boolean(Array.isArray(result) ? false : result.collectorDegraded);
    observerState.lastCaptureError = null;
    observerState.lastSuccessfulCaptureAt = new Date().toISOString();
    // A pause can happen while the native collector is responding. Do not let
    // that in-flight response write a snapshot after the observer was stopped.
    // Completed intervals are still durable activity data and must not be lost.
    if (runId !== undefined && (runId !== observerRunId || !observerState.running)) {
      getDataStore().enqueueActivity(activityEvents);
      return observerState.lastSnapshot;
    }
  } catch (error) {
    windows = [{ appName: 'Observer error', processName: '', title: error.message, processId: null, isForeground: false }];
    observerState.collectorDegraded = true;
    observerState.lastCaptureError = error.message;
    observerState.collectorWarning = `Collection failed: ${error.message}. Existing insights may be stale.`;
  }

  const snapshot = { timestamp, platform: process.platform, windowCount: windows.length, windows, activityEvents };
  liveForeground.update(windows, new Date(timestamp));
  const latest = observerState.lastSnapshot || getDataStore().getLatestSnapshot();
  const changed = hasWindowSetChanged(latest, windows);
  getDataStore().enqueueCapture(snapshot, changed, activityEvents);
  observerState.lastSnapshot = snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snapshot-updated', snapshot);
  return snapshot;
}

function runScheduledCapture() {
  if (captureInFlight) return;
  captureInFlight = true;
  const runId = observerRunId;
  captureSnapshot({ runId }).catch((error) => console.error(`Observer capture failed: ${error.message}`)).finally(() => {
    captureInFlight = false;
  });
}

async function startObserver(intervalMs = observerState.intervalMs) {
  await stopObserver({ closeActivity: false });
  observerRunId += 1;
  observerState = { ...observerState, running: true, intervalMs: normalizeInterval(intervalMs), lastSnapshot: observerState.lastSnapshot };
  runScheduledCapture();
  observerTimer = setInterval(runScheduledCapture, observerState.intervalMs);
  return observerState;
}

async function flushActiveInterval() {
  const events = [];
  try {
    const result = await flushRustActivity();
    if (!Array.isArray(result)) events.push(...(result.activityEvents || []));
  } catch (error) {
    console.error(`Could not flush Rust activity: ${error.message}`);
  }
  events.push(...jsFallbackActivity.flush());
  if (events.length) {
    const store = getDataStore();
    store.enqueueActivity(events);
    store.flush();
  }
}

async function stopObserver({ closeActivity = true } = {}) {
  observerRunId += 1;
  if (observerTimer) clearInterval(observerTimer);
  observerTimer = null;
  observerState.running = false;
  if (closeActivity) await flushActiveInterval();
  liveForeground.clear();
  return observerState;
}

function shutdownRustCollector() {
  if (!rustCollector) return;
  rustCollector.stdin.end('shutdown\n');
  rustCollector = null;
  rejectRustPending(new Error('Rust collector stopped'));
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1120, height: 760, minWidth: 900, minHeight: 600, backgroundColor: '#f6f7fb', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((error) => {
    console.error('Window Observer could not load its UI:', error);
  });
}

function registerIpcHandlers() {
  ipcMain.handle('observer:start', (_, interval) => startObserver(interval));
  ipcMain.handle('observer:stop', () => stopObserver());
  ipcMain.handle('observer:capture', captureSnapshot);
  ipcMain.handle('observer:state', () => {
    const store = getDataStore();
    return {
      ...observerState,
      latest: observerState.lastSnapshot || store.getLatestSnapshot({ flush: false }),
      history: store.getHistory({ flush: false }),
      activity: store.getActivity({ flush: false })
    };
  });
  ipcMain.handle('observer:open-data', () => shell.openPath(dataPaths().directory));
  ipcMain.handle('observer:open-accessibility', openAccessibilitySettings);
  ipcMain.handle('observer:memory', getMemoryUsage);
  ipcMain.handle('observer:insights', () => insightsWithFeedback());
  ipcMain.handle('observer:personal-dashboard', () => personalDashboard());
  ipcMain.handle('observer:feedback', (_, id, status) => {
    const allowed = ['correct', 'expected', 'incorrect', 'ignore'];
    if (!allowed.includes(status)) throw new Error('Invalid feedback status');
    const insights = insightsWithFeedback();
    if (insights.error || !insights.some((insight) => insight.id === id)) throw new Error('Insight not found');
    return { id, ...persistInsightFeedback(id, status) };
  });
  ipcMain.handle('agent:ask', (_, prompt) => askActivityAgent(prompt));
  initializeDataStore();
  startApiServer();
  createWindow();
  startObserver();
}

async function runHeadlessSmokeTest() {
  const snapshot = await captureSnapshot();
  console.log(JSON.stringify(snapshot));
  app.quit();
}

if (process.versions.electron && !hasSingleInstanceLock) {
  app.quit();
}

if (process.versions.electron && hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  app.whenReady().then(process.env.WINDOW_OBSERVER_HEADLESS_TEST === '1' ? runHeadlessSmokeTest : registerIpcHandlers);
  app.on('before-quit', (event) => {
    if (quitFinalizationStarted) return;
    event.preventDefault();
    quitFinalizationStarted = true;
    stopObserver().catch((error) => console.error(`Could not finish active interval: ${error.message}`)).finally(() => {
      if (dataStore) dataStore.close();
      shutdownRustCollector();
      app.quit();
    });
  });
  app.on('will-quit', shutdownRustCollector);
  app.on('will-quit', () => { if (apiServer) apiServer.close(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { cleanWindow, normalizeInterval, hasWindowSetChanged, readJson, writeJson, windowsOpenApps, openAccessibilitySettings, currentFromLatest, askActivityAgent, startObserver, stopObserver, JsFallbackActivityState };

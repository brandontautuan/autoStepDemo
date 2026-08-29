const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cleanWindow, normalizeInterval, hasWindowSetChanged } = require('./observer-core');

let mainWindow;
let observerTimer;
let observerState = { running: false, intervalMs: 10000, lastSnapshot: null };

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
    history: path.join(directory, 'history.json')
  };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

function windowsOpenApps() {
  return new Promise((resolve, reject) => {
    if (process.platform === 'darwin') {
      const script = `
        const systemEvents = Application('System Events');
        const rows = [];
        for (const process of systemEvents.processes()) {
          try {
            if (!process.visible()) continue;
            const appName = process.name();
            const processId = process.unixId();
            const isForeground = Boolean(process.frontmost());
            for (const window of process.windows()) {
              try {
                const title = window.name();
                if (title) rows.push({ appName, processName: appName, title, windowTitle: title, processId, executablePath: '', isForeground });
              } catch (_) {}
            }
          } catch (_) {}
        }
        JSON.stringify(rows);
      `;
      execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5000 }, (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || `${error.message}. Grant Accessibility access to this app in System Settings.`));
        try {
          const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
          resolve((Array.isArray(parsed) ? parsed : [parsed]).map(cleanWindow));
        } catch (parseError) { reject(parseError); }
      });
      return;
    }
    if (process.platform !== 'win32') {
      resolve([{ appName: 'Demo mode', processName: process.platform, title: 'Run this app on Windows to observe windows', processId: process.pid, isForeground: true }]);
      return;
    }

    const script = [
      '$rows = @()',
      'Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | ForEach-Object {',
      '  $rows += [PSCustomObject]@{ appName=$_.Description; processName=$_.ProcessName; title=$_.MainWindowTitle; windowTitle=$_.MainWindowTitle; processId=$_.Id; executablePath=$_.Path; isForeground=$false }',
      '}',
      '$rows | ConvertTo-Json -Depth 3 -Compress'
    ].join('; ');

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const parsed = stdout.trim() ? JSON.parse(stdout) : [];
        resolve((Array.isArray(parsed) ? parsed : [parsed]).map(cleanWindow));
      } catch (parseError) { reject(parseError); }
    });
  });
}

function openAccessibilitySettings() {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility').then(() => true);
}

async function captureSnapshot() {
  const timestamp = new Date().toISOString();
  let windows;
  try {
    windows = await windowsOpenApps();
  } catch (error) {
    windows = [{ appName: 'Observer error', processName: '', title: error.message, processId: null, isForeground: false }];
  }

  const snapshot = { timestamp, platform: process.platform, windowCount: windows.length, windows };
  const paths = dataPaths();
  const latest = readJson(paths.latest, null);
  if (hasWindowSetChanged(latest, windows)) {
    const history = readJson(paths.history, []);
    history.push(snapshot);
    writeJson(paths.history, history);
  }
  writeJson(paths.latest, snapshot);
  observerState.lastSnapshot = snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snapshot-updated', snapshot);
  return snapshot;
}

function startObserver(intervalMs = observerState.intervalMs) {
  stopObserver();
  observerState = { running: true, intervalMs: normalizeInterval(intervalMs), lastSnapshot: observerState.lastSnapshot };
  captureSnapshot();
  observerTimer = setInterval(captureSnapshot, observerState.intervalMs);
  return observerState;
}

function stopObserver() {
  if (observerTimer) clearInterval(observerTimer);
  observerTimer = null;
  observerState.running = false;
  return observerState;
}

function createWindow() {
  mainWindow = new BrowserWindow({ width: 1120, height: 760, minWidth: 900, minHeight: 600, backgroundColor: '#f6f7fb', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  mainWindow.loadFile('index.html');
}

function registerIpcHandlers() {
  ipcMain.handle('observer:start', (_, interval) => startObserver(interval));
  ipcMain.handle('observer:stop', () => stopObserver());
  ipcMain.handle('observer:capture', captureSnapshot);
  ipcMain.handle('observer:state', () => ({ ...observerState, latest: readJson(dataPaths().latest, null), history: readJson(dataPaths().history, []) }));
  ipcMain.handle('observer:open-data', () => shell.openPath(dataPaths().directory));
  ipcMain.handle('observer:open-accessibility', openAccessibilitySettings);
  createWindow();
  startObserver();
}

if (require.main === module) {
  app.whenReady().then(registerIpcHandlers);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { cleanWindow, normalizeInterval, hasWindowSetChanged, readJson, writeJson, windowsOpenApps, openAccessibilitySettings, captureSnapshot, startObserver, stopObserver };

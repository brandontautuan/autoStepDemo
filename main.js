const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { cleanWindow, normalizeInterval, hasWindowSetChanged } = require('./observer-core');

let mainWindow;
let observerTimer;
let rustCollector;
let rustBuffer = '';
let rustPending = [];
let captureInFlight = false;
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
      resolve([{ appName: 'Demo mode', processName: process.platform, title: 'Run this app on Windows to observe windows', processId: process.pid, isForeground: true }]);
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
          activityEvents: response.activityEvents || []
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
  const collector = ensureRustCollector();
  return new Promise((resolve, reject) => {
    if (rustPending.length >= 4) {
      reject(new Error('Rust collector request buffer is full'));
      return;
    }
    rustPending.push({ resolve, reject });
    collector.stdin.write('capture\n', (error) => {
      if (error) {
        const request = rustPending.pop();
        if (request) request.reject(error);
      }
    });
  });
}

function windowsOpenApps() {
  const collector = process.env.WINDOW_OBSERVER_COLLECTOR || (process.platform === 'darwin' ? 'rust' : 'js');
  if (collector !== 'rust') return jsWindowsOpenApps();
  return rustWindowsOpenApps().catch((error) => {
    console.error(`Rust collector unavailable; using JavaScript fallback: ${error.message}`);
    return jsWindowsOpenApps();
  });
}

function openAccessibilitySettings() {
  if (process.platform !== 'darwin') return Promise.resolve(false);
  return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility').then(() => true);
}

async function captureSnapshot() {
  const timestamp = new Date().toISOString();
  let windows;
  let activityEvents = [];
  try {
    const result = await windowsOpenApps();
    windows = Array.isArray(result) ? result : result.windows;
    activityEvents = Array.isArray(result) ? [] : (result.activityEvents || []);
  } catch (error) {
    windows = [{ appName: 'Observer error', processName: '', title: error.message, processId: null, isForeground: false }];
  }

  const snapshot = { timestamp, platform: process.platform, windowCount: windows.length, windows, activityEvents };
  const paths = dataPaths();
  const latest = readJson(paths.latest, null);
  if (hasWindowSetChanged(latest, windows)) {
    const history = readJson(paths.history, []);
    history.push(snapshot);
    if (history.length > 1000) history.splice(0, history.length - 1000);
    writeJson(paths.history, history);
  }
  writeJson(paths.latest, snapshot);
  observerState.lastSnapshot = snapshot;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('snapshot-updated', snapshot);
  return snapshot;
}

function runScheduledCapture() {
  if (captureInFlight) return;
  captureInFlight = true;
  captureSnapshot().catch((error) => console.error(`Observer capture failed: ${error.message}`)).finally(() => {
    captureInFlight = false;
  });
}

function startObserver(intervalMs = observerState.intervalMs) {
  stopObserver();
  observerState = { running: true, intervalMs: normalizeInterval(intervalMs), lastSnapshot: observerState.lastSnapshot };
  runScheduledCapture();
  observerTimer = setInterval(runScheduledCapture, observerState.intervalMs);
  return observerState;
}

function stopObserver() {
  if (observerTimer) clearInterval(observerTimer);
  observerTimer = null;
  observerState.running = false;
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
  ipcMain.handle('observer:state', () => ({ ...observerState, latest: readJson(dataPaths().latest, null), history: readJson(dataPaths().history, []) }));
  ipcMain.handle('observer:open-data', () => shell.openPath(dataPaths().directory));
  ipcMain.handle('observer:open-accessibility', openAccessibilitySettings);
  createWindow();
  startObserver();
}

async function runHeadlessSmokeTest() {
  const snapshot = await captureSnapshot();
  console.log(JSON.stringify(snapshot));
  app.quit();
}

if (process.versions.electron) {
  app.whenReady().then(process.env.WINDOW_OBSERVER_HEADLESS_TEST === '1' ? runHeadlessSmokeTest : registerIpcHandlers);
  app.on('will-quit', shutdownRustCollector);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

module.exports = { cleanWindow, normalizeInterval, hasWindowSetChanged, readJson, writeJson, windowsOpenApps, openAccessibilitySettings, captureSnapshot, startObserver, stopObserver };

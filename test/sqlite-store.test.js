const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SqliteStore } = require('../sqlite-store');

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'window-observer-store-'));
}

function sampleSnapshot(timestamp, title = 'Draft') {
  return {
    timestamp,
    platform: 'darwin',
    windowCount: 1,
    windows: [{
      appName: 'Terminal', processName: 'Terminal', title, windowTitle: title,
      processId: 950, executablePath: '/Applications/Utilities/Terminal.app',
      isForeground: true, isVisible: true, isMinimized: false
    }],
    activityEvents: []
  };
}

test('batches captures, returns canonical activity, and reconstructs snapshots', () => {
  const directory = temporaryDirectory();
  const store = new SqliteStore(directory, { flushMs: 60000, maxQueueSize: 10 }).initialize();
  store.enqueueCapture(sampleSnapshot('2026-08-30T19:34:18.633Z'), true, []);
  store.enqueueCapture(sampleSnapshot('2026-08-30T19:34:28.608Z', 'Shell'), false, [{
    start: '2026-08-30T19:34:18.633Z',
    end: '2026-08-30T19:34:28.608Z',
    durationMs: 9975,
    app: 'Terminal',
    windowTitle: 'autoStepDemo — -zsh — 80×24',
    process: { id: 950, name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }
  }]);
  store.flush();

  assert.equal(store.getHistory().length, 1);
  assert.equal(store.getLatestSnapshot().timestamp, '2026-08-30T19:34:28.608Z');
  assert.deepEqual(store.getActivity(), [{
    start: '2026-08-30T19:34:18.633Z',
    end: '2026-08-30T19:34:28.608Z',
    durationMs: 9975,
    app: 'Terminal',
    normalizedApp: 'terminal',
    windowTitle: 'autoStepDemo — -zsh — 80×24',
    normalizedTitle: 'autoStepDemo — zsh',
    domain: null,
    action: null,
    process: { id: 950, name: 'Terminal', path: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal' }
  }]);
  assert.deepEqual(store.getSummary(), {
    totalTrackedMs: 9975,
    activityCount: 1,
    switchCount: 0,
    apps: [{ appName: 'Terminal', totalDurationMs: 9975, sessions: 1 }]
  });
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test('imports legacy JSON once without deleting it', () => {
  const directory = temporaryDirectory();
  const activityPath = path.join(directory, 'activity.json');
  fs.writeFileSync(activityPath, JSON.stringify([{
    timestamp: 0, appName: 'Safari', windowTitle: 'Example', processId: 42,
    processName: 'Safari', executablePath: '/Applications/Safari.app', durationMs: 1500
  }]));
  fs.writeFileSync(path.join(directory, 'latest.json'), JSON.stringify(sampleSnapshot('2026-08-30T19:34:28.608Z')));

  const store = new SqliteStore(directory).initialize();
  assert.equal(store.getActivity().length, 1);
  assert.equal(store.getLatestSnapshot().timestamp, '2026-08-30T19:34:28.608Z');
  assert.ok(fs.existsSync(activityPath));
  store.close();

  const reopened = new SqliteStore(directory).initialize();
  assert.equal(reopened.getActivity().length, 1);
  reopened.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanWindow, normalizeInterval, windowSignature, hasWindowSetChanged, readableActivityEvent, summarizeActivity } = require('../observer-core');

test('cleanWindow applies the persisted window schema and safe defaults', () => {
  assert.deepEqual(cleanWindow({ appName: '', processId: '42', isForeground: 1 }), {
    appName: 'Unknown app', processName: '', title: '', windowTitle: '', processId: 42,
    executablePath: '', isForeground: true, isVisible: true, isMinimized: false
  });
  assert.equal(cleanWindow({ processId: 'not-a-number' }).processId, null);
});

test('normalizeInterval enforces the two-second minimum and default', () => {
  assert.equal(normalizeInterval(100), 2000);
  assert.equal(normalizeInterval('5000'), 5000);
  assert.equal(normalizeInterval('invalid'), 10000);
});

test('windowSignature ignores foreground-only changes', () => {
  const first = [{ appName: 'Editor', processId: 1, isForeground: true }];
  const second = [{ appName: 'Editor', processId: 1, isForeground: false }];
  assert.equal(windowSignature(first), windowSignature(second));
});

test('hasWindowSetChanged detects added, removed, and modified windows', () => {
  const previous = { windows: [{ appName: 'Editor', processId: 1, isForeground: true }] };
  assert.equal(hasWindowSetChanged(previous, [{ appName: 'Editor', processId: 1, isForeground: false }]), false);
  assert.equal(hasWindowSetChanged(previous, []), true);
  assert.equal(hasWindowSetChanged(previous, [{ appName: 'Browser', processId: 2 }]), true);
  assert.equal(hasWindowSetChanged(null, []), true);
});

test('readableActivityEvent keeps only human-readable activity fields plus duration', () => {
  assert.deepEqual(readableActivityEvent({
    timestamp: 0,
    appName: 'Safari',
    windowTitle: 'Example',
    executablePath: '/Applications/Safari.app',
    processId: '42',
    processName: 'Safari',
    durationMs: '1500',
    isForeground: true,
    isVisible: true
  }), {
    timestamp: '1970-01-01T00:00:00.000Z',
    windowTitle: 'Example',
    appName: 'Safari',
    path: '/Applications/Safari.app',
    processId: 42,
    processName: 'Safari',
    durationMs: 1500
  });
});

test('summarizeActivity aggregates durations, sessions, and app switches', () => {
  assert.deepEqual(summarizeActivity([
    { appName: 'Safari', durationMs: 200 },
    { appName: 'Code', durationMs: 500 },
    { appName: 'Safari', durationMs: 300 }
  ]), {
    totalTrackedMs: 1000,
    activityCount: 3,
    switchCount: 2,
    apps: [
      { appName: 'Code', totalDurationMs: 500, sessions: 1 },
      { appName: 'Safari', totalDurationMs: 500, sessions: 2 }
    ]
  });
});

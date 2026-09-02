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

test('readableActivityEvent emits the canonical interval schema', () => {
  assert.deepEqual(readableActivityEvent({
    start: '2026-08-30T19:34:18.633Z',
    end: '2026-08-30T19:34:28.608Z',
    appName: 'Terminal',
    windowTitle: 'autoStepDemo — -zsh — 80×24',
    executablePath: '/Applications/Utilities/Terminal.app',
    processId: '42',
    processName: 'Terminal',
    durationMs: '9975'
  }), {
    start: '2026-08-30T19:34:18.633Z',
    end: '2026-08-30T19:34:28.608Z',
    durationMs: 9975,
    app: 'Terminal',
    normalizedApp: 'terminal',
    windowTitle: 'autoStepDemo — -zsh — 80×24',
    normalizedTitle: 'autoStepDemo — zsh',
    domain: null,
    action: null,
    process: { id: 42, name: 'Terminal', path: '/Applications/Utilities/Terminal.app' }
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

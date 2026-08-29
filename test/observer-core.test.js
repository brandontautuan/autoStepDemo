const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanWindow, normalizeInterval, windowSignature, hasWindowSetChanged } = require('../observer-core');

test('cleanWindow applies the persisted window schema and safe defaults', () => {
  assert.deepEqual(cleanWindow({ appName: '', processId: '42', isForeground: 1 }), {
    appName: 'Unknown app', processName: '', title: '', processId: 42,
    executablePath: '', isForeground: true
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

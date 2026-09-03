const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { escapeHtml } = require('../renderer-utils');

function activitySummary(activity) {
  return activity.reduce((result, item) => {
    const app = item.appName || 'Unknown app';
    result.apps[app] = (result.apps[app] || 0) + Number(item.durationMs || 0);
    result.total += Number(item.durationMs || 0);
    return result;
  }, { apps: {}, total: 0 });
}

test('escapeHtml escapes every character that can break rendered markup', () => {
  assert.equal(escapeHtml(`<img src="x" onerror='bad'> &`), '&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt; &amp;');
});

test('escapeHtml stringifies nullish and numeric values', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(null), 'null');
});

test('dashboard activity summary groups durations by app', () => {
  assert.deepEqual(activitySummary([
    { appName: 'Code', durationMs: 120000 },
    { appName: 'Safari', durationMs: 30000 },
    { appName: 'Code', durationMs: 45000 },
  ]), { apps: { Code: 165000, Safari: 30000 }, total: 195000 });
});

test('insight cards render confidence as an evidence label, never a percentage', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /insight\.confidenceLabel/);
  assert.doesNotMatch(renderer, /Math\.round\(insight\.confidence \* 100\)/);
});

test('UI exposes intentional loading, empty, error, and degraded-collector states', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(renderer, /No work signals yet/);
  assert.match(renderer, /Could not load friction insights/);
  assert.match(renderer, /Observer degraded/);
  assert.match(renderer, /Window Observer is excluded from capture/);
  assert.match(markup, /id="collectorWarning"/);
});

test('observer controls refresh complete stored state instead of rendering an incomplete start/stop response', () => {
  const renderer = fs.readFileSync(path.join(__dirname, '..', 'renderer.js'), 'utf8');
  assert.match(renderer, /if \(state\.running\) await window\.observer\.stop\(\);/);
  assert.match(renderer, /await refresh\(\);/);
  assert.doesNotMatch(renderer, /render\(state\.running \? await window\.observer\.stop\(\)/);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { escapeHtml } = require('../renderer-utils');

test('escapeHtml escapes every character that can break rendered markup', () => {
  assert.equal(escapeHtml(`<img src="x" onerror='bad'> &`), '&lt;img src=&quot;x&quot; onerror=&#39;bad&#39;&gt; &amp;');
});

test('escapeHtml stringifies nullish and numeric values', () => {
  assert.equal(escapeHtml(123), '123');
  assert.equal(escapeHtml(null), 'null');
});

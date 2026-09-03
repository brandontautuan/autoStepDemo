const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLocalApiHandler } = require('../local-api');

function dependencies(overrides = {}) {
  const feedback = {};
  return {
    feedback,
    values: {
      getActivity: () => [],
      getLatestSnapshot: () => ({ timestamp: '2026-09-02T10:00:00.000Z', windows: [] }),
      getSummary: () => ({ totalTrackedMs: 0, activityCount: 0, switchCount: 0, apps: [] }),
      getInsights: () => [{ id: 'insight-1', title: 'Frequent app switching' }],
      getPersonalDashboard: () => ({
        generatedAt: '2026-09-02T10:00:00.000Z',
        range: { start: '2026-09-02T07:00:00.000Z', end: '2026-09-03T07:00:00.000Z', timezone: 'America/Los_Angeles' },
        isLive: false, currentWork: null, journal: [], tasksToResume: [], standupDraft: {}, frictionSummary: []
      }),
      saveFeedback: (id, status) => {
        const value = { status, updatedAt: '2026-09-02T10:00:00.000Z' };
        feedback[id] = value;
        return value;
      },
      currentFromLatest: (latest) => ({ capturedAt: latest.timestamp, currentWindow: null }),
      ...overrides
    }
  };
}

function invoke(values, { method = 'GET', url, body } = {}) {
  return new Promise((resolve) => {
    const request = new EventEmitter();
    request.method = method;
    request.url = url;
    const response = {
      statusCode: null,
      headers: null,
      writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
      end(payload) { resolve({ status: this.statusCode, headers: this.headers, body: JSON.parse(payload) }); }
    };
    createLocalApiHandler(values)(request, response);
    if (method === 'POST') {
      process.nextTick(() => {
        if (body !== undefined) request.emit('data', body);
        request.emit('end');
      });
    }
  });
}

test('local API returns valid JSON for every empty-data GET route', async () => {
  const { values } = dependencies();
  const activity = await invoke(values, { url: '/api/activity' });
  const current = await invoke(values, { url: '/api/current' });
  const summary = await invoke(values, { url: '/api/summary' });
  const insights = await invoke(values, { url: '/api/insights' });
  const personalDashboard = await invoke(values, { url: '/api/personal-dashboard' });
  assert.equal(activity.status, 200);
  assert.deepEqual(activity.body, []);
  assert.equal(current.status, 200);
  assert.deepEqual(summary.body, { totalTrackedMs: 0, activityCount: 0, switchCount: 0, apps: [] });
  assert.equal(insights.body[0].id, 'insight-1');
  assert.equal(personalDashboard.body.generatedAt, '2026-09-02T10:00:00.000Z');
  assert.equal(personalDashboard.body.range.timezone, 'America/Los_Angeles');
  assert.equal(personalDashboard.body.currentWork, null);
  [activity, current, summary, insights, personalDashboard].forEach((response) => assert.match(response.headers['Content-Type'], /^application\/json/));
});

test('local API validates and persists every feedback status', async () => {
  const { values, feedback } = dependencies();
  for (const status of ['correct', 'expected', 'incorrect', 'ignore']) {
    const response = await invoke(values, { method: 'POST', url: '/api/insights/insight-1/feedback', body: JSON.stringify({ status }) });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, status);
  }
  assert.equal(feedback['insight-1'].status, 'ignore');
  const invalid = await invoke(values, { method: 'POST', url: '/api/insights/insight-1/feedback', body: JSON.stringify({ status: 'bad' }) });
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /Feedback status/);
});

test('local API returns JSON errors for absent, malformed, and failed route data', async () => {
  const missingCurrent = dependencies({ getLatestSnapshot: () => null }).values;
  const malformedActivity = dependencies({ getActivity: () => ({}) }).values;
  const unavailableInsights = dependencies({ getInsights: () => { throw new Error('database unavailable'); } }).values;
  const normal = dependencies().values;
  const responses = [
    await invoke(missingCurrent, { url: '/api/current' }),
    await invoke(malformedActivity, { url: '/api/activity' }),
    await invoke(normal, { url: '/api/insights/missing' }),
    await invoke(normal, { method: 'DELETE', url: '/api/activity' }),
    await invoke(unavailableInsights, { url: '/api/insights' })
  ];
  assert.deepEqual(responses.map((response) => response.status), [404, 500, 404, 405, 500]);
  responses.forEach((response) => assert.equal(typeof response.body.error, 'string'));
});

test('local API rejects malformed feedback JSON without crashing', async () => {
  const { values } = dependencies();
  const response = await invoke(values, { method: 'POST', url: '/api/insights/insight-1/feedback', body: '{bad json' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /valid JSON/);
});

const { URL } = require('url');

const FEEDBACK_STATUSES = new Set(['correct', 'expected', 'incorrect', 'ignore']);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

function readRequestBody(request, maxBytes = 10000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    request.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) fail(new HttpError(413, 'Request body is too large'));
    });
    request.on('end', () => {
      if (settled) return;
      try {
        settled = true;
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    request.on('error', (error) => fail(new HttpError(400, error.message || 'Could not read request body')));
  });
}

function pathnameFor(requestUrl) {
  try { return new URL(requestUrl, 'http://127.0.0.1').pathname; } catch { return null; }
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new HttpError(500, `${label} data is malformed`);
  return value;
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(500, `${label} data is malformed`);
  return value;
}

function createLocalApiHandler({ getActivity, getLatestSnapshot, getSummary, getInsights, getPersonalDashboard, saveFeedback, currentFromLatest }) {
  return async (request, response) => {
    try {
      const pathname = pathnameFor(request.url);
      if (!pathname) throw new HttpError(400, 'Invalid request URL');
      const feedbackMatch = pathname.match(/^\/api\/insights\/([^/]+)\/feedback$/);
      const allowsPost = request.method === 'POST' && feedbackMatch;
      if (request.method !== 'GET' && !allowsPost) {
        throw new HttpError(405, 'Method not allowed');
      }

      if (allowsPost) {
        const body = await readRequestBody(request);
        const status = String(body.status || '').toLowerCase();
        if (!FEEDBACK_STATUSES.has(status)) {
          throw new HttpError(400, 'Feedback status must be correct, expected, incorrect, or ignore');
        }
        let insightId;
        try { insightId = decodeURIComponent(feedbackMatch[1]); } catch { throw new HttpError(400, 'Insight id is invalid'); }
        const insights = requireArray(getInsights(), 'Insights');
        if (!insights.some((insight) => insight.id === insightId)) throw new HttpError(404, 'Insight not found');
        const saved = saveFeedback(insightId, status);
        return sendJson(response, 200, { id: insightId, ...saved });
      }

      if (pathname === '/api/activity') return sendJson(response, 200, requireArray(getActivity(), 'Activity'));
      if (pathname === '/api/current') {
        const latest = getLatestSnapshot();
        if (!latest || typeof latest !== 'object' || Array.isArray(latest)) throw new HttpError(404, 'Current snapshot data is not available yet');
        return sendJson(response, 200, currentFromLatest(latest));
      }
      if (pathname === '/api/summary') return sendJson(response, 200, requireObject(getSummary(), 'Summary'));
      if (pathname === '/api/insights') return sendJson(response, 200, requireArray(getInsights(), 'Insights'));
      if (pathname === '/api/personal-dashboard') return sendJson(response, 200, requireObject(getPersonalDashboard(), 'Personal dashboard'));

      const insightMatch = pathname.match(/^\/api\/insights\/([^/]+)$/);
      if (insightMatch) {
        let insightId;
        try { insightId = decodeURIComponent(insightMatch[1]); } catch { throw new HttpError(400, 'Insight id is invalid'); }
        const insight = requireArray(getInsights(), 'Insights').find((item) => item.id === insightId);
        if (!insight) throw new HttpError(404, 'Insight not found');
        return sendJson(response, 200, insight);
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      return sendJson(response, statusCode, { error: error.message || 'Local API request failed' }, statusCode === 405 ? { Allow: 'GET, POST' } : {});
    }
  };
}

module.exports = { FEEDBACK_STATUSES, HttpError, sendJson, readRequestBody, pathnameFor, createLocalApiHandler };

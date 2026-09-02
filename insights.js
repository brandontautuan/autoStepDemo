const DEFAULT_HOURLY_RATE = 60;
const DEFAULT_THRESHOLDS = {
  longFocusMs: 5 * 60 * 1000,
  switchBurstCount: 5,
  switchBurstWindowMs: 15 * 60 * 1000,
  revisitCount: 3,
  revisitWindowMs: 30 * 60 * 1000
};

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeApp(app) {
  return String(app || 'Unknown app').trim().replace(/\s+/g, ' ').toLowerCase();
}

function normalizeTitle(title) {
  return String(title || '').trim().replace(/\s+/g, ' ');
}

function parseTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeActivityRecord(record = {}, sourceIndex = 0) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const app = String(record.app || record.appName || 'Unknown app').trim() || 'Unknown app';
  const windowTitle = normalizeTitle(record.windowTitle || record.title || '');
  const durationMs = record.durationMs != null
    ? numberOrNull(record.durationMs)
    : (record.duration != null ? numberOrNull(record.duration) * 1000 : null);
  if (durationMs == null || durationMs < 0) return null;

  const end = parseTimestamp(record.end || record.timestamp);
  const start = parseTimestamp(record.start) || (end ? new Date(end.getTime() - durationMs) : null);
  const resolvedEnd = end || (start ? new Date(start.getTime() + durationMs) : null);
  if (!start || !resolvedEnd) return null;

  return {
    start: start.toISOString(),
    end: resolvedEnd.toISOString(),
    startMs: start.getTime(),
    endMs: resolvedEnd.getTime(),
    durationMs: Math.max(0, Math.round(durationMs)),
    app,
    normalizedApp: normalizeApp(record.normalizedApp || app),
    windowTitle,
    normalizedTitle: normalizeTitle(record.normalizedTitle || windowTitle),
    process: record.process && typeof record.process === 'object'
      ? { id: numberOrNull(record.process.id), name: String(record.process.name || ''), path: String(record.process.path || '') }
      : { id: numberOrNull(record.processId), name: String(record.processName || ''), path: String(record.path || record.executablePath || '') },
    sourceIndex
  };
}

function normalizeActivity(records) {
  if (!Array.isArray(records)) return [];
  return records
    .map(normalizeActivityRecord)
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function estimatedCost(durationMs, hourlyRate) {
  return Math.round((durationMs / 3600000) * hourlyRate * 100) / 100;
}

function confidenceForLongInterval(durationMs, threshold) {
  return Math.min(0.99, Math.round((0.65 + (durationMs - threshold) / Math.max(threshold * 4, 1)) * 100) / 100);
}

function evidenceFor(record) {
  return {
    start: record.start,
    end: record.end,
    durationMs: record.durationMs,
    app: record.app,
    windowTitle: record.windowTitle,
    process: record.process
  };
}

function insightBase(id, type, title, description, severity, confidence, evidence, metrics, suggestion) {
  return { id, type, title, description, severity, confidence, metrics, evidence, suggestion, status: null };
}

function detectLongFocus(records, thresholds, hourlyRate) {
  return records
    .filter((record) => record.durationMs >= thresholds.longFocusMs)
    .map((record) => {
      const confidence = confidenceForLongInterval(record.durationMs, thresholds.longFocusMs);
      return insightBase(
        `long-focus-${record.startMs}-${record.sourceIndex}`,
        'long_focus_interval',
        `Long focus interval in ${record.app}`,
        `${record.app} stayed in the foreground for ${Math.round(record.durationMs / 60000)} minutes.`,
        record.durationMs >= thresholds.longFocusMs * 2 ? 'high' : 'medium',
        confidence,
        [evidenceFor(record)],
        { durationMs: record.durationMs, estimatedCost: estimatedCost(record.durationMs, hourlyRate) },
        'Review this interval and decide whether the work can be batched, shortened, or automated.'
      );
    });
}

function detectSwitchBursts(records, thresholds, hourlyRate) {
  const insights = [];
  for (let start = 0; start < records.length; start += 1) {
    const first = records[start];
    const end = records.findIndex((record, index) => index >= start && record.startMs > first.startMs + thresholds.switchBurstWindowMs);
    const endIndex = end === -1 ? records.length : end;
    const window = records.slice(start, endIndex);
    const switchCount = window.slice(1).reduce((count, record, index) => count + (record.normalizedApp !== window[index].normalizedApp ? 1 : 0), 0);
    if (switchCount < thresholds.switchBurstCount) continue;
    const last = window[window.length - 1];
    const durationMs = Math.max(0, last.endMs - first.startMs);
    const id = `switch-burst-${first.startMs}-${last.endMs}`;
    if (insights.some((insight) => insight.id === id)) continue;
    insights.push(insightBase(
      id,
      'context_switch_burst',
      'Context-switch burst',
      `${switchCount} app switches occurred within ${Math.round((last.endMs - first.startMs) / 60000)} minutes.`,
      switchCount >= thresholds.switchBurstCount + 3 ? 'high' : 'medium',
      Math.min(0.98, Math.round((0.7 + (switchCount - thresholds.switchBurstCount) * 0.04) * 100) / 100),
      window.map(evidenceFor),
      { durationMs, switchCount, estimatedCost: estimatedCost(durationMs, hourlyRate) },
      'Look for a repeated handoff or tool change that could be consolidated.'
    ));
  }
  return insights;
}

function detectRepeatedRevisits(records, thresholds, hourlyRate) {
  const groups = new Map();
  records.forEach((record) => {
    const key = `${record.normalizedApp}::${record.normalizedTitle}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  return [...groups.entries()]
    .filter(([, occurrences]) => occurrences.length >= thresholds.revisitCount)
    .map(([key, occurrences]) => {
      const evidence = occurrences.filter((record, index) => index === 0 || record.startMs - occurrences[index - 1].endMs <= thresholds.revisitWindowMs);
      if (evidence.length < thresholds.revisitCount) return null;
      const durationMs = evidence.reduce((total, record) => total + record.durationMs, 0);
      const revisitCount = evidence.length - 1;
      const first = evidence[0];
      const label = first.windowTitle || first.app;
      return insightBase(
        `revisit-${key}-${first.startMs}`,
        'repeated_revisit',
        `Repeated revisit to ${label}`,
        `${label} appeared ${evidence.length} times in the recent activity flow.`,
        revisitCount >= 4 ? 'high' : 'medium',
        Math.min(0.97, Math.round((0.68 + revisitCount * 0.06) * 100) / 100),
        evidence.map(evidenceFor),
        { durationMs, revisitCount, estimatedCost: estimatedCost(durationMs, hourlyRate) },
        'Check whether this task is being interrupted, revisited for status, or waiting on another step.'
      );
    })
    .filter(Boolean);
}

function generateInsights(activity, options = {}) {
  const records = normalizeActivity(activity);
  const hourlyRate = numberOrNull(options.hourlyRate) ?? DEFAULT_HOURLY_RATE;
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  if (!records.length) return [];
  return [
    ...detectLongFocus(records, thresholds, hourlyRate),
    ...detectSwitchBursts(records, thresholds, hourlyRate),
    ...detectRepeatedRevisits(records, thresholds, hourlyRate)
  ].sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id));
}

module.exports = {
  DEFAULT_HOURLY_RATE,
  DEFAULT_THRESHOLDS,
  normalizeActivityRecord,
  normalizeActivity,
  estimatedCost,
  generateInsights
};

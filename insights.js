const DEFAULT_THRESHOLDS = {
  longFocusMs: 5 * 60 * 1000,
  switchBurstCount: 5,
  switchBurstWindowMs: 15 * 60 * 1000,
  switchBurstMergeGapMs: 2 * 60 * 1000,
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
  if (!start || !resolvedEnd || resolvedEnd.getTime() < start.getTime()) return null;
  return {
    start: start.toISOString(), end: resolvedEnd.toISOString(), startMs: start.getTime(), endMs: resolvedEnd.getTime(),
    durationMs: Math.max(0, Math.round(durationMs)), app, normalizedApp: normalizeApp(record.normalizedApp || app),
    windowTitle, normalizedTitle: normalizeTitle(record.normalizedTitle || windowTitle),
    process: record.process && typeof record.process === 'object'
      ? { id: numberOrNull(record.process.id), name: String(record.process.name || ''), path: String(record.process.path || '') }
      : { id: numberOrNull(record.processId), name: String(record.processName || ''), path: String(record.path || record.executablePath || '') },
    sourceIndex,
    intervalId: record.intervalId ?? record.id ?? `input:${sourceIndex}`
  };
}

function normalizeActivity(records) {
  if (!Array.isArray(records)) return [];
  return records.map(normalizeActivityRecord).filter(Boolean).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || a.sourceIndex - b.sourceIndex);
}

function confidenceLabel(confidence) {
  if (confidence >= 0.8) return 'Strong evidence';
  if (confidence >= 0.6) return 'Moderate evidence';
  return 'Weak signal';
}

function foregroundChanges(records) {
  return records.slice(1).reduce((count, record, index) => record.normalizedApp !== records[index].normalizedApp ? count + 1 : count, 0);
}

function distinctApps(records) {
  const apps = new Map();
  records.forEach((record) => { if (!apps.has(record.normalizedApp)) apps.set(record.normalizedApp, record.app); });
  return [...apps.values()];
}

function evidenceFor(record) {
  return { start: record.start, end: record.end, durationMs: record.durationMs, app: record.app, windowTitle: record.windowTitle, process: record.process };
}

function evidenceDetails(records, overrides = {}) {
  const repeated = new Map();
  records.forEach((record) => {
    const key = `${record.normalizedApp}::${record.normalizedTitle}`;
    const current = repeated.get(key) || { app: record.app, windowTitle: record.windowTitle, count: 0 };
    current.count += 1;
    repeated.set(key, current);
  });
  const topRepeated = [...repeated.values()].sort((a, b) => b.count - a.count || a.app.localeCompare(b.app))[0] || null;
  const appSequence = records.reduce((items, record) => {
    const previous = items[items.length - 1];
    if (!previous || previous.normalizedApp !== record.normalizedApp || previous.normalizedTitle !== record.normalizedTitle) {
      items.push({ app: record.app, windowTitle: record.windowTitle, normalizedApp: record.normalizedApp, normalizedTitle: record.normalizedTitle });
    }
    return items;
  }, []);
  return {
    start: records[0]?.start || null,
    end: records[records.length - 1]?.end || null,
    foregroundChanges: foregroundChanges(records),
    distinctApps: distinctApps(records),
    appSequence,
    topRepeated,
    ...overrides
  };
}

function roundedMinutes(durationMs) { return Math.max(1, Math.round(durationMs / 60000)); }

function signalLabel(category, impact, confidence) {
  if (category === 'work_pattern') return 'Work pattern';
  return impact === 'high' && confidence >= 0.8 ? 'Needs review' : 'Possible friction';
}

function insightBase({ id, type, category, title, summary, description, whyItMayMatter, whyItMayBeNormal, confidence, impact, evidence, details, metrics, rank }) {
  return {
    id, type, category, title, summary, description, whyItMayMatter, whyItMayBeNormal,
    confidence, confidenceLabel: confidenceLabel(confidence), impact, signalLabel: signalLabel(category, impact, confidence),
    evidence: evidence.map(evidenceFor), evidenceDetails: details, metrics, rank, status: null
  };
}

function detectLongFocusBlocks(records, thresholds) {
  const qualifying = records.filter((record) => record.durationMs >= thresholds.longFocusMs);
  const repeatedByApp = new Map();
  qualifying.forEach((record) => {
    const items = repeatedByApp.get(record.normalizedApp) || [];
    items.push(record);
    repeatedByApp.set(record.normalizedApp, items);
  });
  const groupedApps = new Set([...repeatedByApp.entries()].filter(([, items]) => items.length >= 3).map(([app]) => app));
  const insights = [];
  repeatedByApp.forEach((items, app) => {
    if (!groupedApps.has(app)) return;
    const totalDurationMs = items.reduce((total, item) => total + item.durationMs, 0);
    const titles = [...new Set(items.map((item) => item.windowTitle || 'Untitled window'))];
    const titleContext = titles.slice(0, 2).join('; ');
    const evidence = items;
    insights.push(insightBase({
      id: `long-focus-group-${app}-${items[0].startMs}`,
      type: 'long_focus_block', category: 'work_pattern', title: `Focus blocks in ${items[0].app}`,
      summary: `${items.length} focus blocks totaling ${roundedMinutes(totalDurationMs)} minutes${titleContext ? ` · ${titleContext}${titles.length > 2 ? '…' : ''}` : ''}`,
      description: `${items[0].app} had ${items.length} completed focus blocks totaling ${roundedMinutes(totalDurationMs)} minutes. The captured titles provide context for what was open; this is a neutral work pattern, not friction.`,
      whyItMayMatter: 'It provides a compact view of sustained work across several completed foreground intervals.',
      whyItMayBeNormal: 'Several focus blocks in the same app commonly reflect normal, sustained work.',
      confidence: 0.75, impact: 'low', evidence, details: evidenceDetails(evidence, { focusBlockCount: items.length, focusTitles: titles }),
      metrics: { durationMs: totalDurationMs, distinctApps: 1, focusBlockCount: items.length }, rank: 50
    }));
  });
  qualifying.filter((record) => !groupedApps.has(record.normalizedApp)).forEach((record) => {
    const evidence = [record];
    const titleContext = record.windowTitle ? ` — ${record.windowTitle}` : '';
    insights.push(insightBase({
      id: `long-focus-${record.startMs}-${record.sourceIndex}`,
      type: 'long_focus_block', category: 'work_pattern', title: `Long focus block in ${record.app}${titleContext}`,
      summary: `${record.app} stayed in the foreground for ${roundedMinutes(record.durationMs)} minutes${record.windowTitle ? ` · ${record.windowTitle}` : ''}`,
      description: `${record.app}${record.windowTitle ? ` — ${record.windowTitle}` : ''} remained in the foreground for ${roundedMinutes(record.durationMs)} minutes. This often reflects focused work rather than friction.`,
      whyItMayMatter: 'It is useful context if it is later interrupted or repeatedly restarted, but it is not a problem on its own.',
      whyItMayBeNormal: 'A sustained foreground block can simply mean you were concentrating on one task.',
      confidence: 0.7, impact: 'low', evidence, details: evidenceDetails(evidence),
      metrics: { durationMs: record.durationMs, distinctApps: 1 }, rank: 50
    }));
  });
  return insights;
}

function switchCandidates(records, thresholds) {
  const candidates = [];
  for (let startIndex = 0; startIndex < records.length; startIndex += 1) {
    const first = records[startIndex];
    const limit = first.startMs + thresholds.switchBurstWindowMs;
    const endIndex = records.findIndex((record, index) => index >= startIndex && record.startMs > limit);
    const evidence = records.slice(startIndex, endIndex === -1 ? records.length : endIndex);
    const switchCount = foregroundChanges(evidence);
    if (switchCount < thresholds.switchBurstCount) continue;
    const last = evidence[evidence.length - 1];
    candidates.push({ startMs: first.startMs, endMs: last.endMs, durationMs: Math.max(0, last.endMs - first.startMs), switchCount, evidence });
  }
  return candidates;
}

function mergeSwitchCandidates(candidates, mergeGapMs) {
  const groups = [];
  candidates.forEach((candidate) => {
    const current = groups[groups.length - 1];
    if (!current || candidate.startMs > current.endMs + mergeGapMs) {
      groups.push({ startMs: candidate.startMs, endMs: candidate.endMs, candidates: [candidate] });
      return;
    }
    current.endMs = Math.max(current.endMs, candidate.endMs);
    current.candidates.push(candidate);
  });
  return groups.map((group) => {
    const evidence = [...new Map(group.candidates.flatMap((candidate) => candidate.evidence).map((record) => [record.sourceIndex, record])).values()]
      .sort((a, b) => a.startMs - b.startMs || a.sourceIndex - b.sourceIndex);
    const peak = group.candidates.reduce((best, candidate) => candidate.switchCount > best.switchCount ? candidate : best);
    return { ...group, evidence, peak };
  });
}

function detectSwitchBursts(records, thresholds) {
  return mergeSwitchCandidates(switchCandidates(records, thresholds), thresholds.switchBurstMergeGapMs).map((burst) => {
    const involvedApps = distinctApps(burst.evidence);
    const peakChanges = burst.peak.switchCount;
    const peakDurationMs = burst.peak.durationMs;
    const confidence = Math.min(0.9, 0.64 + Math.min(peakChanges, 12) * 0.02 + Math.min(involvedApps.length, 5) * 0.02);
    const impact = peakChanges >= 8 && involvedApps.length >= 3 ? 'high' : 'medium';
    return insightBase({
      id: `switch-burst-${burst.startMs}`,
      type: 'context_switch_burst', category: 'friction', title: 'Frequent app switching',
      summary: `${peakChanges} foreground changes in ${roundedMinutes(peakDurationMs)} minutes`,
      description: `Your foreground app changed ${peakChanges} times during this ${roundedMinutes(peakDurationMs)}-minute window. This can indicate fragmented work, but it may also be normal if you were comparing information across tools.`,
      whyItMayMatter: 'Frequent switches can make it harder to hold context and may reveal an avoidable handoff between tools.',
      whyItMayBeNormal: 'Research, debugging, and coordinating work often require deliberate switching between several apps.',
      confidence, impact, evidence: burst.evidence,
      details: evidenceDetails(burst.evidence, {
        foregroundChanges: foregroundChanges(burst.evidence), peakForegroundChanges: peakChanges,
        peakWindowStart: burst.peak.evidence[0].start, peakWindowEnd: burst.peak.evidence[burst.peak.evidence.length - 1].end,
        involvedApps
      }),
      metrics: { foregroundChanges: peakChanges, distinctApps: involvedApps.length, totalWindowStart: burst.evidence[0].start, totalWindowEnd: burst.evidence[burst.evidence.length - 1].end },
      rank: impact === 'high' ? 300 : 240
    });
  });
}

function clusterOccurrences(records, gapMs) {
  const groups = [];
  records.forEach((record) => {
    const current = groups[groups.length - 1];
    if (!current || record.startMs - current[current.length - 1].endMs > gapMs) groups.push([record]);
    else current.push(record);
  });
  return groups;
}

function detectRepeatedRevisits(records, thresholds) {
  const grouped = new Map();
  records.forEach((record) => {
    const key = `${record.normalizedApp}::${record.normalizedTitle}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(record);
  });
  const insights = [];
  grouped.forEach((occurrences, key) => {
    clusterOccurrences(occurrences, thresholds.revisitWindowMs).forEach((cluster) => {
      if (cluster.length < thresholds.revisitCount) return;
      const supporting = records.filter((record) => record.startMs >= cluster[0].startMs && record.endMs <= cluster[cluster.length - 1].endMs);
      const interruptions = cluster.slice(1).reduce((count, occurrence, index) => {
        const previous = cluster[index];
        return count + (supporting.some((record) => record.startMs >= previous.endMs && record.endMs <= occurrence.startMs && `${record.normalizedApp}::${record.normalizedTitle}` !== key) ? 1 : 0);
      }, 0);
      if (interruptions < 2) return;
      const first = cluster[0];
      const label = first.windowTitle || first.app;
      const revisitCount = cluster.length - 1;
      const confidence = Math.min(0.9, 0.64 + revisitCount * 0.06 + interruptions * 0.03);
      const impact = revisitCount >= 3 && interruptions >= 3 ? 'high' : 'medium';
      insights.push(insightBase({
        id: `revisit-${key}-${first.startMs}`,
        type: 'repeated_revisit', category: 'friction', title: `Repeated return to ${label}`,
        summary: `${revisitCount} returns after switching away`,
        description: `You returned to ${label} ${revisitCount} times after switching to other work. This can indicate interrupted flow, but it may also be normal monitoring or follow-up.`,
        whyItMayMatter: 'Returning to the same task after interruptions can add setup time and make the work harder to resume.',
        whyItMayBeNormal: 'Some work naturally involves checking progress, responding to messages, or comparing changes.',
        confidence, impact, evidence: supporting,
        details: evidenceDetails(supporting, { revisitCount, interruptionCount: interruptions }),
        metrics: { revisitCount, interruptionCount: interruptions, distinctApps: distinctApps(supporting).length },
        rank: impact === 'high' ? 280 : 220
      }));
    });
  });
  return insights;
}

function generateInsights(activity, options = {}) {
  const records = normalizeActivity(activity);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  if (!records.length) return [];
  return [
    ...detectSwitchBursts(records, thresholds),
    ...detectRepeatedRevisits(records, thresholds),
    ...detectLongFocusBlocks(records, thresholds)
  ].sort((a, b) => b.rank - a.rank || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

function applyFeedback(insights, feedback = {}) {
  return insights.map((insight) => {
    const entry = feedback[insight.id];
    const status = entry?.status || null;
    if (!status) return insight;
    if (status === 'ignore') return { ...insight, status, feedbackUpdatedAt: entry.updatedAt || null, signalLabel: 'Dismissed', rank: insight.rank - 10000 };
    // "Expected" is feedback about a friction signal, not a reclassification of
    // that signal into a neutral work pattern. Keep its label/category intact
    // and only lower its rank.
    if (status === 'expected') return { ...insight, status, feedbackUpdatedAt: entry.updatedAt || null, rank: insight.rank - 500 };
    if (status === 'incorrect') return { ...insight, status, feedbackUpdatedAt: entry.updatedAt || null, rank: insight.rank - 250 };
    return { ...insight, status, feedbackUpdatedAt: entry.updatedAt || null };
  }).sort((a, b) => b.rank - a.rank || b.confidence - a.confidence || a.id.localeCompare(b.id));
}

module.exports = {
  DEFAULT_THRESHOLDS,
  normalizeActivityRecord,
  normalizeActivity,
  confidenceLabel,
  foregroundChanges,
  mergeSwitchCandidates,
  detectSwitchBursts,
  generateInsights,
  applyFeedback
};

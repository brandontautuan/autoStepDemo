const $ = (id) => document.getElementById(id);
const dateTime = (value) => new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit' });
const { escapeHtml } = typeof require === 'function' ? require('./renderer-utils') : { escapeHtml: (value) => String(value).replace(/[&<>'\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[char])) };
const activityDurationMs = (item) => item.duration != null ? Number(item.duration || 0) * 1000 : Number(item.durationMs || 0);
const activityTime = (item) => item.end || item.timestamp;
const durationText = (durationMs) => { const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); if (hours) return `${hours}h ${minutes}m`; return `${minutes}m ${seconds % 60}s`; };
const activitySummary = (activity) => activity.reduce((result, item) => { const app = item.app || item.appName || 'Unknown app'; const durationMs = activityDurationMs(item); result.apps[app] = (result.apps[app] || 0) + durationMs; result.total += durationMs; return result; }, { apps: {}, total: 0 });
const memoryText = (kilobytes) => { const megabytes = Number(kilobytes || 0) / 1024; return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(2)} GB` : `${megabytes.toFixed(1)} MB`; };
const memoryProcessLabel = (type) => ({ browser: 'Main process', renderer: 'Renderer', gpu: 'GPU', utility: 'Utility' }[type] || type);
const shortTime = (value) => new Date(value).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
const stateClass = (value) => String(value || '').toLowerCase().replace(/\s+/g, '-');
function insightCard(insight) {
  const details = insight.evidenceDetails || {};
  const metrics = [];
  if (insight.metrics.foregroundChanges != null) metrics.push(`${insight.metrics.foregroundChanges} foreground changes`);
  if (insight.metrics.revisitCount != null) metrics.push(`${insight.metrics.revisitCount} returns`);
  if (insight.metrics.durationMs != null) metrics.push(durationText(insight.metrics.durationMs));
  if (insight.metrics.distinctApps != null) metrics.push(`${insight.metrics.distinctApps} distinct app${insight.metrics.distinctApps === 1 ? '' : 's'}`);
  const feedback = ['correct', 'expected', 'incorrect', 'ignore'];
  const range = details.start && details.end ? `${shortTime(details.start)} – ${shortTime(details.end)}` : 'Unavailable';
  const sequence = (details.appSequence || []).map((item) => item.windowTitle ? `${item.app} — ${item.windowTitle}` : item.app).join(' → ');
  const topRepeated = details.topRepeated ? `${details.topRepeated.app}${details.topRepeated.windowTitle ? ` — ${details.topRepeated.windowTitle}` : ''}${details.topRepeated.count > 1 ? ` (${details.topRepeated.count} intervals)` : ''}` : 'Unavailable';
  return `<details class="insight-card ${escapeHtml(insight.status || '')}"><summary><div class="insight-summary"><span class="signal-label ${escapeHtml(stateClass(insight.signalLabel))}">${escapeHtml(insight.signalLabel)}</span><div><strong>${escapeHtml(insight.title)}</strong><span>${escapeHtml(insight.summary || insight.description)}</span></div><b class="evidence-confidence">${escapeHtml(insight.confidenceLabel)}</b></div></summary><div class="insight-body"><p class="insight-description">${escapeHtml(insight.description)}</p><div class="insight-explanation"><div><strong>Why it may matter</strong><span>${escapeHtml(insight.whyItMayMatter)}</span></div><div><strong>Why it might be normal</strong><span>${escapeHtml(insight.whyItMayBeNormal)}</span></div></div><div class="insight-metrics">${metrics.map((part) => `<span>${escapeHtml(part)}</span>`).join('')}</div><div class="evidence-label">EVIDENCE · ${insight.evidence.length} interval${insight.evidence.length === 1 ? '' : 's'}</div><dl class="evidence-facts"><div><dt>Time range</dt><dd>${escapeHtml(range)}</dd></div><div><dt>Foreground changes</dt><dd>${escapeHtml(String(details.peakForegroundChanges ?? details.foregroundChanges ?? 0))}</dd></div><div><dt>Distinct apps</dt><dd>${escapeHtml(String((details.involvedApps || details.distinctApps || []).length))}</dd></div><div><dt>Top repeated app/title</dt><dd>${escapeHtml(topRepeated)}</dd></div></dl><div class="app-sequence"><strong>App sequence</strong><span>${escapeHtml(sequence || 'Unavailable')}</span></div><div class="insight-evidence">${insight.evidence.map((event) => `<div class="evidence-row"><div><strong>${escapeHtml(event.app)}</strong><span>${escapeHtml(event.windowTitle || 'Untitled window')}</span></div><time>${durationText(event.durationMs)}<br>${shortTime(event.start)}</time></div>`).join('')}</div><div class="feedback-row"><span>${insight.status ? `Marked ${escapeHtml(insight.status)}` : 'Is this signal real for you?'}</span>${feedback.map((status) => `<button data-feedback="${status}" data-insight="${escapeHtml(insight.id)}" class="${insight.status === status ? 'selected' : ''}">${status[0].toUpperCase()}${status.slice(1)}</button>`).join('')}</div></div></details>`;
}
function renderInsights(insights) {
  const list = $('insightsList');
  if (!Array.isArray(insights)) { list.innerHTML = '<div class="insights-state error-state">Could not load friction insights.</div>'; return; }
  if (!insights.length) { list.innerHTML = '<div class="insights-state">No work signals yet. Keep the observer running while you work.</div>'; return; }
  const friction = insights.filter((insight) => insight.category === 'friction' && !['expected', 'ignore'].includes(insight.status));
  const patterns = insights.filter((insight) => insight.category === 'work_pattern' || insight.status === 'expected');
  const dismissed = insights.filter((insight) => insight.status === 'ignore');
  const section = (title, items) => items.length ? `<div class="insight-group"><h3>${escapeHtml(title)}</h3>${items.map(insightCard).join('')}</div>` : '';
  list.innerHTML = section('Potential friction', friction) + section('Work patterns', patterns) + section('Reviewed signals', dismissed) || '<div class="insights-state">No work signals yet. Keep the observer running while you work.</div>';
  list.querySelectorAll('[data-feedback]').forEach((button) => button.addEventListener('click', async (event) => {
    event.preventDefault();
    button.disabled = true;
    try { await window.observer.feedback(button.dataset.insight, button.dataset.feedback); await refreshInsights(); } catch (error) { button.closest('.insight-body').insertAdjacentHTML('beforeend', `<div class="insights-state error-state">${escapeHtml(error.message)}</div>`); } finally { button.disabled = false; }
  }));
}
async function refreshInsights() { try { renderInsights(await window.observer.insights()); } catch (error) { renderInsights(null); } }
function renderMemory(memory) {
  if (!memory) return;
  $('memoryTotal').textContent = memoryText(memory.totalWorkingSetKB);
  $('memoryUpdated').textContent = `Updated ${dateTime(memory.capturedAt)}`;
  const processes = Array.isArray(memory.processes) ? memory.processes : [];
  $('memoryProcesses').innerHTML = processes.length ? processes.map((item) => `<div class="memory-process"><div><strong>${escapeHtml(memoryProcessLabel(item.type))}</strong><span>PID ${item.pid || '—'}</span></div><strong>${memoryText(item.workingSetSizeKB)}</strong></div>`).join('') : '<div class="empty">No process metrics available.</div>';
}
function renderDashboard(state) {
  const activity = Array.isArray(state.activity) ? state.activity : [];
  const summary = activitySummary(activity);
  const apps = Object.entries(summary.apps).sort((a, b) => b[1] - a[1]);
  $('trackedTime').textContent = durationText(summary.total);
  $('activityCount').textContent = activity.length;
  $('trackedApps').textContent = apps.length;
  const ordered = activity.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  $('switchCount').textContent = ordered.reduce((count, item, index) => count + (index && (ordered[index - 1].app || ordered[index - 1].appName) !== (item.app || item.appName) ? 1 : 0), 0);
  const maxDuration = apps[0]?.[1] || 1;
  $('activityApps').innerHTML = apps.length ? apps.map(([app, duration]) => `<div class="activity-app"><div class="activity-app-head"><strong>${escapeHtml(app)}</strong><span>${durationText(duration)}</span></div><div class="bar"><i style="width:${Math.max(3, Math.round(duration / maxDuration * 100))}%"></i></div></div>`).join('') : '<div class="empty">Activity will appear here.</div>';
  $('activityTimeline').innerHTML = activity.length ? activity.slice().reverse().slice(0, 10).map((item) => `<div class="timeline-item"><div><strong>${escapeHtml(item.app || item.appName || 'Unknown app')}</strong><span>${escapeHtml(item.action || item.domain || item.windowTitle || item.title || 'Untitled window')}</span></div><time>${durationText(activityDurationMs(item))}<br>${dateTime(activityTime(item))}</time></div>`).join('') : '<div class="empty">Activity will appear here.</div>';
  const selected = $('rawDataset').value;
  $('rawJson').textContent = JSON.stringify(selected === 'latest' ? (state.latest || {}) : (state[selected] || []), null, 2);
}
function render(state) {
  const snapshot = state.latest;
  const windows = snapshot?.windows || [];
  $('windowCount').textContent = `${windows.length} ${windows.length === 1 ? 'window' : 'windows'}`;
  $('platformBadge').textContent = snapshot?.platform === 'win32' ? 'Windows' : (snapshot?.platform || 'desktop');
  $('statusText').textContent = state.running ? 'Observer is running' : 'Observer is paused';
  $('statusDot').classList.toggle('paused', !state.running);
  $('lastUpdated').textContent = snapshot ? `Last scan ${dateTime(snapshot.timestamp)}` : 'Waiting for first snapshot…';
  $('toggle').textContent = state.running ? 'Pause observer' : 'Resume observer';
  $('appList').innerHTML = windows.length ? windows.map((item) => `<div class="app-row"><div class="app-icon">${(item.appName || '?').slice(0,1).toUpperCase()}</div><div><div class="app-name">${escapeHtml(item.appName)}${item.isMinimized ? ' <small>(minimized)</small>' : ''}</div><div class="app-title">${escapeHtml(item.title || item.processName || 'Untitled window')}</div></div>${item.isForeground ? '<span class="foreground">FOREGROUND</span>' : ''}</div>`).join('') : '<div class="empty">No open windows found.</div>';
  const history = state.history || [];
  $('snapshotCount').textContent = `${history.length} ${history.length === 1 ? 'snapshot' : 'snapshots'} saved`;
  $('historyList').innerHTML = history.slice().reverse().slice(0, 8).map((entry) => `<div class="history-item"><span>${entry.windowCount} open ${entry.windowCount === 1 ? 'window' : 'windows'}</span><time>${dateTime(entry.timestamp)}</time></div>`).join('') || '<div class="empty">Changes will appear here.</div>';
  renderDashboard(state);
}
async function refresh() { render(await window.observer.state()); }
async function refreshMemory() { try { renderMemory(await window.observer.memory()); } catch (error) { $('memoryUpdated').textContent = 'Memory unavailable'; } }
$('toggle').addEventListener('click', async () => { const state = await window.observer.state(); render(state.running ? await window.observer.stop() : await window.observer.start(Number($('interval').value))); });
$('interval').addEventListener('change', async () => { const state = await window.observer.state(); if (state.running) render(await window.observer.start(Number($('interval').value))); });
$('capture').addEventListener('click', async () => { await window.observer.capture(); refresh(); });
$('openData').addEventListener('click', () => window.observer.openData());
$('rawDataset').addEventListener('change', refresh);
async function askAgent() {
  const prompt = $('agentPrompt').value.trim();
  if (!prompt) return;
  $('askAgent').disabled = true;
  $('agentStatus').textContent = 'Reviewing your activity…';
  $('agentAnswer').textContent = '';
  try {
    $('agentAnswer').textContent = await window.observer.askAgent(prompt);
    $('agentStatus').textContent = 'Answer ready';
  } catch (error) {
    $('agentStatus').textContent = 'Agent request failed';
    $('agentAnswer').textContent = error.message;
  } finally { $('askAgent').disabled = false; }
}
$('askAgent').addEventListener('click', askAgent);
$('agentPrompt').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') askAgent(); });
if (navigator.platform.toLowerCase().includes('mac')) {
  $('permissionBanner').style.display = 'flex';
  $('openAccessibility').addEventListener('click', () => window.observer.openAccessibility());
}
window.observer.onSnapshot(() => { refresh(); refreshInsights(); });
refresh();
refreshInsights();
refreshMemory();
setInterval(refreshMemory, 2000);

const $ = (id) => document.getElementById(id);
const dateTime = (value) => new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit' });
const { escapeHtml } = typeof require === 'function' ? require('./renderer-utils') : { escapeHtml: (value) => String(value).replace(/[&<>'\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[char])) };
const durationText = (durationMs) => { const seconds = Math.max(0, Math.floor(Number(durationMs || 0) / 1000)); const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); if (hours) return `${hours}h ${minutes}m`; return `${minutes}m ${seconds % 60}s`; };
const activitySummary = (activity) => activity.reduce((result, item) => { const app = item.appName || 'Unknown app'; result.apps[app] = (result.apps[app] || 0) + Number(item.durationMs || 0); result.total += Number(item.durationMs || 0); return result; }, { apps: {}, total: 0 });
function renderDashboard(state) {
  const activity = Array.isArray(state.activity) ? state.activity : [];
  const summary = activitySummary(activity);
  const apps = Object.entries(summary.apps).sort((a, b) => b[1] - a[1]);
  $('trackedTime').textContent = durationText(summary.total);
  $('activityCount').textContent = activity.length;
  $('trackedApps').textContent = apps.length;
  const ordered = activity.slice().sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  $('switchCount').textContent = ordered.reduce((count, item, index) => count + (index && ordered[index - 1].appName !== item.appName ? 1 : 0), 0);
  const maxDuration = apps[0]?.[1] || 1;
  $('activityApps').innerHTML = apps.length ? apps.map(([app, duration]) => `<div class="activity-app"><div class="activity-app-head"><strong>${escapeHtml(app)}</strong><span>${durationText(duration)}</span></div><div class="bar"><i style="width:${Math.max(3, Math.round(duration / maxDuration * 100))}%"></i></div></div>`).join('') : '<div class="empty">Activity will appear here.</div>';
  $('activityTimeline').innerHTML = activity.length ? activity.slice().reverse().slice(0, 10).map((item) => `<div class="timeline-item"><div><strong>${escapeHtml(item.appName || 'Unknown app')}</strong><span>${escapeHtml(item.windowTitle || item.title || 'Untitled window')}</span></div><time>${durationText(item.durationMs)}<br>${dateTime(item.timestamp)}</time></div>`).join('') : '<div class="empty">Activity will appear here.</div>';
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
$('toggle').addEventListener('click', async () => { const state = await window.observer.state(); render(state.running ? await window.observer.stop() : await window.observer.start(Number($('interval').value))); });
$('interval').addEventListener('change', async () => { const state = await window.observer.state(); if (state.running) render(await window.observer.start(Number($('interval').value))); });
$('capture').addEventListener('click', async () => { await window.observer.capture(); refresh(); });
$('openData').addEventListener('click', () => window.observer.openData());
$('rawDataset').addEventListener('change', refresh);
if (navigator.platform.toLowerCase().includes('mac')) {
  $('permissionBanner').style.display = 'flex';
  $('openAccessibility').addEventListener('click', () => window.observer.openAccessibility());
}
window.observer.onSnapshot(() => refresh());
refresh();

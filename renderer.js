const $ = (id) => document.getElementById(id);
const dateTime = (value) => new Date(value).toLocaleString([], { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', second:'2-digit' });
const { escapeHtml } = typeof require === 'function' ? require('./renderer-utils') : { escapeHtml: (value) => String(value).replace(/[&<>'\"]/g, (char) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[char])) };
function render(state) {
  const snapshot = state.latest;
  const windows = snapshot?.windows || [];
  $('windowCount').textContent = `${windows.length} ${windows.length === 1 ? 'window' : 'windows'}`;
  $('platformBadge').textContent = snapshot?.platform === 'win32' ? 'Windows' : (snapshot?.platform || 'desktop');
  $('statusText').textContent = state.running ? 'Observer is running' : 'Observer is paused';
  $('statusDot').classList.toggle('paused', !state.running);
  $('lastUpdated').textContent = snapshot ? `Last scan ${dateTime(snapshot.timestamp)}` : 'Waiting for first snapshot…';
  $('toggle').textContent = state.running ? 'Pause observer' : 'Resume observer';
  $('appList').innerHTML = windows.length ? windows.map((item) => `<div class="app-row"><div class="app-icon">${(item.appName || '?').slice(0,1).toUpperCase()}</div><div><div class="app-name">${escapeHtml(item.appName)}</div><div class="app-title">${escapeHtml(item.title || item.processName || 'No window title')}</div></div>${item.isForeground ? '<span class="foreground">FOREGROUND</span>' : ''}</div>`).join('') : '<div class="empty">No visible app windows found.</div>';
  const history = state.history || [];
  $('snapshotCount').textContent = `${history.length} ${history.length === 1 ? 'snapshot' : 'snapshots'} saved`;
  $('historyList').innerHTML = history.slice().reverse().slice(0, 8).map((entry) => `<div class="history-item"><span>${entry.windowCount} open ${entry.windowCount === 1 ? 'window' : 'windows'}</span><time>${dateTime(entry.timestamp)}</time></div>`).join('') || '<div class="empty">Changes will appear here.</div>';
}
async function refresh() { render(await window.observer.state()); }
$('toggle').addEventListener('click', async () => { const state = await window.observer.state(); render(state.running ? await window.observer.stop() : await window.observer.start(Number($('interval').value))); });
$('interval').addEventListener('change', async () => { const state = await window.observer.state(); if (state.running) render(await window.observer.start(Number($('interval').value))); });
$('capture').addEventListener('click', async () => { await window.observer.capture(); refresh(); });
$('openData').addEventListener('click', () => window.observer.openData());
if (navigator.platform.toLowerCase().includes('mac')) {
  $('permissionBanner').style.display = 'flex';
  $('openAccessibility').addEventListener('click', () => window.observer.openAccessibility());
}
window.observer.onSnapshot(render);
refresh();

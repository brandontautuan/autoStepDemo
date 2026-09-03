const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { readableActivityEvent, summarizeActivity } = require('./observer-core');

const SCHEMA_VERSION = '2';
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE = 50;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validActivityInterval(rawEvent, event) {
  rawEvent = rawEvent && typeof rawEvent === 'object' ? rawEvent : {};
  const rawDurationMs = rawEvent.durationMs != null
    ? Number(rawEvent.durationMs)
    : (rawEvent.duration != null ? Number(rawEvent.duration) * 1000 : null);
  const startMs = Date.parse(event.start);
  const endMs = Date.parse(event.end);
  return Number.isFinite(rawDurationMs)
    && rawDurationMs >= 0
    && Number.isFinite(startMs)
    && Number.isFinite(endMs)
    && endMs >= startMs;
}

function cleanSnapshot(snapshot = {}) {
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  return {
    timestamp: typeof snapshot.timestamp === 'string' ? snapshot.timestamp : new Date().toISOString(),
    platform: String(snapshot.platform || process.platform),
    windowCount: Number.isFinite(Number(snapshot.windowCount)) ? Number(snapshot.windowCount) : windows.length,
    windows,
    activityEvents: Array.isArray(snapshot.activityEvents) ? snapshot.activityEvents : []
  };
}

class SqliteStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.databasePath = path.join(directory, 'observer.sqlite');
    this.flushMs = options.flushMs || DEFAULT_FLUSH_MS;
    this.maxQueueSize = options.maxQueueSize || DEFAULT_MAX_QUEUE_SIZE;
    this.onFlush = options.onFlush || null;
    this.pending = [];
    this.flushTimer = null;
    this.db = null;
  }

  initialize() {
    if (this.db) return this;
    fs.mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY,
        captured_at TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        window_count INTEGER NOT NULL,
        changed INTEGER NOT NULL DEFAULT 0,
        activity_events_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS snapshot_windows (
        id INTEGER PRIMARY KEY,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        app_name TEXT NOT NULL,
        process_name TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        window_title TEXT NOT NULL DEFAULT '',
        process_id INTEGER,
        executable_path TEXT NOT NULL DEFAULT '',
        is_foreground INTEGER NOT NULL DEFAULT 0,
        is_visible INTEGER NOT NULL DEFAULT 1,
        is_minimized INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS activity_intervals (
        id INTEGER PRIMARY KEY,
        start_at TEXT NOT NULL,
        end_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL CHECK(duration_ms >= 0),
        app_name TEXT NOT NULL,
        normalized_app TEXT NOT NULL,
        window_title TEXT NOT NULL DEFAULT '',
        normalized_title TEXT NOT NULL DEFAULT '',
        domain TEXT,
        action TEXT,
        source TEXT NOT NULL DEFAULT 'legacy-json',
        process_id INTEGER,
        process_name TEXT NOT NULL DEFAULT '',
        process_path TEXT NOT NULL DEFAULT '',
        UNIQUE(start_at, end_at, app_name, window_title, process_id)
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at ON snapshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_snapshots_changed_captured_at ON snapshots(changed, captured_at);
      CREATE INDEX IF NOT EXISTS idx_activity_start_at ON activity_intervals(start_at);
      CREATE INDEX IF NOT EXISTS idx_activity_app_start_at ON activity_intervals(app_name, start_at);
    `);
    const schemaVersion = this.metadata('schema_version');
    if (schemaVersion && Number(schemaVersion) > Number(SCHEMA_VERSION)) {
      throw new Error(`Observer database schema ${schemaVersion} is newer than this app supports`);
    }
    if (!schemaVersion) this.setMetadata('schema_version', SCHEMA_VERSION);
    if (schemaVersion === '1') {
      const columns = this.db.prepare('PRAGMA table_info(activity_intervals)').all();
      if (!columns.some((column) => column.name === 'source')) {
        this.db.exec("ALTER TABLE activity_intervals ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy-json'");
      }
      this.setMetadata('schema_version', SCHEMA_VERSION);
    }
    this.importLegacyJsonOnce();
    return this;
  }

  setMetadata(key, value) {
    this.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  metadata(key) {
    return this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key)?.value || null;
  }

  importLegacyJsonOnce() {
    if (this.metadata('legacy_json_imported_at')) return;
    const activity = readJson(path.join(this.directory, 'activity.json'), []);
    const history = readJson(path.join(this.directory, 'history.json'), []);
    const latest = readJson(path.join(this.directory, 'latest.json'), null);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (Array.isArray(history)) history.forEach((snapshot) => this.insertSnapshot(snapshot, true));
      if (latest && typeof latest === 'object' && !Array.isArray(latest)) this.insertSnapshot(latest, false);
      if (Array.isArray(activity)) activity.forEach((event) => this.insertActivity({ ...event, source: event.source || 'legacy-json' }));
      this.setMetadata('legacy_json_imported_at', new Date().toISOString());
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  enqueueCapture(snapshot, changed, activityEvents = []) {
    this.initialize();
    const events = Array.isArray(activityEvents) ? activityEvents.filter((event) => event && typeof event === 'object') : [];
    this.pending.push({ snapshot: cleanSnapshot(snapshot), changed: Boolean(changed), activityEvents: events });
    if (this.pending.length >= this.maxQueueSize) this.flush();
    else this.scheduleFlush();
  }

  enqueueActivity(activityEvents = []) {
    this.initialize();
    const events = Array.isArray(activityEvents) ? activityEvents.filter((event) => event && typeof event === 'object') : [];
    if (!events.length) return;
    this.pending.push({ snapshot: null, changed: false, activityEvents: events });
    if (this.pending.length >= this.maxQueueSize) this.flush();
    else this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try { this.flush(); } catch (error) { console.error(`SQLite flush failed: ${error.message}`); }
    }, this.flushMs);
    this.flushTimer.unref?.();
  }

  flush() {
    this.initialize();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.pending.length) return;
    const batch = this.pending;
    this.pending = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      batch.forEach(({ snapshot, changed, activityEvents }) => {
        if (snapshot) this.insertSnapshot(snapshot, changed);
        activityEvents.forEach((event) => this.insertActivity(event));
      });
      this.db.exec('COMMIT');
      try { this.onFlush?.(batch); } catch (error) { console.error(`SQLite flush callback failed: ${error.message}`); }
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.pending.unshift(...batch);
      throw error;
    }
  }

  insertSnapshot(value, changed) {
    const snapshot = cleanSnapshot(value);
    const result = this.db.prepare(`
      INSERT INTO snapshots (captured_at, platform, window_count, changed, activity_events_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(captured_at) DO NOTHING
    `).run(snapshot.timestamp, snapshot.platform, snapshot.windowCount, changed ? 1 : 0, JSON.stringify(snapshot.activityEvents));
    if (!result.changes) return;
    const snapshotId = Number(result.lastInsertRowid);
    const insertWindow = this.db.prepare(`
      INSERT INTO snapshot_windows (
        snapshot_id, app_name, process_name, title, window_title, process_id,
        executable_path, is_foreground, is_visible, is_minimized
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    snapshot.windows.forEach((window = {}) => {
      insertWindow.run(
        snapshotId,
        String(window.appName || 'Unknown app'),
        String(window.processName || ''),
        String(window.title || ''),
        String(window.windowTitle || window.title || ''),
        numberOrNull(window.processId),
        String(window.executablePath || window.path || ''),
        window.isForeground ? 1 : 0,
        window.isVisible === false ? 0 : 1,
        window.isMinimized ? 1 : 0
      );
    });
  }

  insertActivity(value) {
    const event = readableActivityEvent(value);
    if (!validActivityInterval(value, event)) return false;
    this.db.prepare(`
      INSERT INTO activity_intervals (
        start_at, end_at, duration_ms, app_name, normalized_app, window_title,
        normalized_title, domain, action, source, process_id, process_name, process_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(start_at, end_at, app_name, window_title, process_id) DO NOTHING
    `).run(
      event.start, event.end, event.durationMs, event.app, event.normalizedApp,
      event.windowTitle, event.normalizedTitle, event.domain, event.action, event.source,
      numberOrNull(event.process.id), event.process.name, event.process.path
    );
    return true;
  }

  getLatestSnapshot({ flush = true } = {}) {
    if (flush) this.flush(); else this.initialize();
    const row = this.db.prepare('SELECT id FROM snapshots ORDER BY captured_at DESC LIMIT 1').get();
    return row ? this.getSnapshots('WHERE s.id = ?', [row.id])[0] : null;
  }

  getHistory({ flush = true } = {}) {
    if (flush) this.flush(); else this.initialize();
    return this.getSnapshots('WHERE s.changed = 1');
  }

  getSnapshots(where = '', params = []) {
    this.initialize();
    const rows = this.db.prepare(`
      SELECT
        s.id AS snapshot_id, s.captured_at, s.platform, s.window_count, s.activity_events_json,
        w.id AS window_id, w.app_name, w.process_name, w.title, w.window_title,
        w.process_id, w.executable_path, w.is_foreground, w.is_visible, w.is_minimized
      FROM snapshots s
      LEFT JOIN snapshot_windows w ON w.snapshot_id = s.id
      ${where}
      ORDER BY s.captured_at ASC, w.id ASC
    `).all(...params);
    const snapshots = new Map();
    rows.forEach((row) => {
      if (!snapshots.has(row.snapshot_id)) {
        let activityEvents = [];
        try { activityEvents = JSON.parse(row.activity_events_json); } catch {}
        snapshots.set(row.snapshot_id, {
          timestamp: row.captured_at,
          platform: row.platform,
          windowCount: row.window_count,
          windows: [],
          activityEvents: Array.isArray(activityEvents) ? activityEvents : []
        });
      }
      if (row.window_id == null) return;
      snapshots.get(row.snapshot_id).windows.push({
        appName: row.app_name,
        processName: row.process_name,
        title: row.title,
        windowTitle: row.window_title,
        processId: row.process_id,
        executablePath: row.executable_path,
        isForeground: Boolean(row.is_foreground),
        isVisible: Boolean(row.is_visible),
        isMinimized: Boolean(row.is_minimized)
      });
    });
    return [...snapshots.values()];
  }

  getActivity({ flush = true } = {}) {
    if (flush) this.flush(); else this.initialize();
    return this.db.prepare(`
      SELECT id, start_at, end_at, duration_ms, app_name, normalized_app, window_title,
        normalized_title, domain, action, source, process_id, process_name, process_path
      FROM activity_intervals
      ORDER BY start_at ASC, id ASC
    `).all().map((row) => ({
      id: row.id,
      start: row.start_at,
      end: row.end_at,
      durationMs: row.duration_ms,
      app: row.app_name,
      normalizedApp: row.normalized_app,
      windowTitle: row.window_title,
      normalizedTitle: row.normalized_title,
      domain: row.domain,
      action: row.action,
      source: row.source,
      process: { id: row.process_id, name: row.process_name, path: row.process_path }
    }));
  }

  getSummary({ flush = true } = {}) {
    if (flush) this.flush(); else this.initialize();
    const totals = this.db.prepare('SELECT COUNT(*) AS activity_count, COALESCE(SUM(duration_ms), 0) AS total_tracked_ms FROM activity_intervals').get();
    const apps = this.db.prepare(`
      SELECT app_name AS appName, SUM(duration_ms) AS totalDurationMs, COUNT(*) AS sessions
      FROM activity_intervals
      GROUP BY app_name
      ORDER BY totalDurationMs DESC, appName ASC
    `).all().map((row) => ({
      appName: row.appName,
      totalDurationMs: row.totalDurationMs,
      sessions: row.sessions
    }));
    const appNames = this.db.prepare('SELECT app_name FROM activity_intervals ORDER BY start_at ASC, id ASC').all();
    const switchCount = appNames.reduce((count, row, index) => count + (index > 0 && row.app_name !== appNames[index - 1].app_name ? 1 : 0), 0);
    return {
      totalTrackedMs: totals.total_tracked_ms,
      activityCount: totals.activity_count,
      switchCount,
      apps
    };
  }

  close() {
    if (!this.db) return;
    this.flush();
    this.db.close();
    this.db = null;
  }
}

module.exports = { SqliteStore, readJson, validActivityInterval, DEFAULT_FLUSH_MS, DEFAULT_MAX_QUEUE_SIZE };

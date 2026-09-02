# Window Observer

Local Electron app that polls macOS application windows and records interval activity locally in SQLite.

## Run

```bash
npm install
npm start
```

The supported deployment target for this migration is macOS. The Rust collector is selected by default on macOS and uses Core Graphics to enumerate active, on-screen layer-0 windows. Minimized and hidden windows are excluded, while untitled on-screen windows are retained. The observer’s own window is excluded. Set `WINDOW_OBSERVER_COLLECTOR=js` to force the JavaScript fallback, which applies the same active-window filter through JXA.

The supported collector behavior is active-window only: Core Graphics keeps on-screen layer-0 windows, while minimized and hidden windows are excluded. Untitled on-screen windows are retained. Snapshot history is unbounded and committed atomically in SQLite.

## Stored data

When running with `npm start`, the app writes directly into this repository:

```text
observer-data/
```

Packaged builds use Electron’s writable `userData/observer-data` directory instead. You can also override the location with the `WINDOW_OBSERVER_DATA_DIR` environment variable.

The repository folder contains:

- `observer.sqlite` — the durable database. It stores every capture, windows associated with each capture, and completed foreground intervals.
- `feedback.json` — feedback attached to deterministic insights.

On first startup, existing `latest.json`, `history.json`, and `activity.json` files are imported into `observer.sqlite` once and left in place. They are no longer written after the migration.

Activity interval records returned by the API contain `start`, `end`, `durationMs`, `app`, `normalizedApp`, `windowTitle`, `normalizedTitle`, nullable `domain` and `action`, and a nested `process` object with `id`, `name`, and `path`.

Each window includes `appName`, `processName`, `title`, `windowTitle`, `processId`, `executablePath`, `isForeground`, `isVisible`, and `isMinimized`. Empty titles are retained as untitled windows.

Rust-backed snapshots may also include `activityEvents`, containing completed foreground intervals in the collector transport schema. Electron normalizes and batches these records before committing them to SQLite. Pausing or quitting the observer closes and persists the active interval. Closing and reopening an app creates a new interval; both intervals remain in the log.

Pending captures are committed in one SQLite transaction after up to one second or when 50 captures are queued. The pending batch is flushed synchronously during shutdown.

No screenshots, keystrokes, or network uploads are collected.

## Local API

The Electron main process also serves localhost-only read routes at `http://127.0.0.1:47821`:

- `GET /api/activity` — returns completed foreground intervals queried from SQLite.
- `GET /api/current` — returns the capture time and foreground window from the most recent SQLite snapshot.
- `GET /api/summary` — returns compact totals aggregated from SQLite.
- `GET /api/insights` — returns deterministic work-friction findings with metrics and evidence.
- `GET /api/insights/:id` — returns one friction finding.
- `POST /api/insights/:id/feedback` — stores `correct`, `expected`, `incorrect`, or `ignore` feedback in `feedback.json`.

Set `WINDOW_OBSERVER_API_PORT` to use a different local port. No external network interface is opened.

## Python activity agent

Run the dependency-free local agent while Electron is running:

```bash
python3 activity_agent.py --app "Visual Studio Code" --minutes 60
```

The agent calls `/api/summary` first to verify app totals, then `/api/activity` to build the recent chronological flow, and finally `/api/current` for the current foreground window. Set `WINDOW_OBSERVER_API_URL` if the API uses a non-default local port.

To use the hosted Groq reasoning layer, install the Python dependency and set `GROQ_API_KEY` in `.env` (never commit it):

```bash
python3 -m pip install -r requirements.txt
# edit .env and set GROQ_API_KEY="your-key-here"
python3 activity_agent.py --ask "How much time did I spend in Visual Studio Code and what was my recent app flow?"
```

The Groq chat-completions wrapper uses `openai/gpt-oss-20b` by default, forces `get_activity_summary` first, then lets the model call the detailed activity and current-window tools. It has conservative safeguards by default: at most 3 model requests and 3 total tool calls per `--ask`, each tool can be called only once, requests are spaced by 0.5 seconds, and no more than 10 requests are allowed per process minute. The response is capped at 800 output tokens. Tune these with the corresponding `GROQ_...` environment variables if desired.

## Rust collector (Phases 1–3; Phase 4 groundwork)

The `rust-collector/` directory contains a standalone collector. On macOS, `npm run rust:build` also builds a native Accessibility helper used by Rust, with JXA retained as a fallback. The collector can perform one-shot collection or stay running and accept `capture` commands on stdin, emitting one JSON response per command. Rust also emits completed foreground intervals as additive `activityEvents`. Electron uses it by default on macOS; set `WINDOW_OBSERVER_COLLECTOR=js` to use the JavaScript fallback.

Build and run it directly with:

```bash
cargo build --manifest-path rust-collector/Cargo.toml
swiftc -O -framework AppKit -framework ApplicationServices rust-collector/macos-native/main.swift -o rust-collector/target/debug/macos-native-collector
./rust-collector/target/debug/window-observer-collector --once --exclude-pid $$
```

To exercise the Rust-backed Electron path after building the collector (this is also the macOS default):

```bash
WINDOW_OBSERVER_COLLECTOR=rust npm start
```

For a non-UI smoke test, the Electron main process supports a one-capture mode:

```bash
WINDOW_OBSERVER_HEADLESS_TEST=1 WINDOW_OBSERVER_DATA_DIR=/tmp/window-observer-test npm start
```

Run the headless Mac collector benchmark with:

```bash
npm run rust:build
npm run benchmark:macos -- --iterations=10
```

It compares the persistent native helper, persistent Rust collector, and one-shot JXA fallback for latency and best-effort resident memory. It does not open Electron or write observer data.

The native helper uses Core Graphics window metadata and is designed to avoid blocking on individual Accessibility elements. Accessibility permission may still be needed by the JavaScript fallback and Electron UI.

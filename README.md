# Window Observer

Local Electron app that observes application windows and records foreground activity locally in SQLite. The UI includes an activity dashboard, runtime memory details, explainable work signals, and an optional activity agent.

## Run

```bash
npm install
npm start
```

The supported deployment target is macOS. The Rust collector is selected by default on macOS and uses Core Graphics to enumerate active, on-screen layer-0 windows. Minimized and hidden windows are excluded, while untitled on-screen windows are retained. The observer’s own window is excluded.

To exercise the JavaScript fallback collector explicitly:

```bash
WINDOW_OBSERVER_COLLECTOR=js npm start
```

The status panel identifies this mode as `JS fallback`. Completed intervals produced in this mode have `source: "js-fallback"`. If Rust fails and the app falls back automatically, the status panel shows a warning that collection is degraded and existing insights may be stale.

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

Activity interval records returned by the API contain `start`, `end`, `durationMs`, `app`, `normalizedApp`, `windowTitle`, `normalizedTitle`, `source`, nullable `domain` and `action`, and a nested `process` object with `id`, `name`, and `path`. Invalid timestamps, reversed intervals, and invalid durations are ignored before persistence.

Each window includes `appName`, `processName`, `title`, `windowTitle`, `processId`, `executablePath`, `isForeground`, `isVisible`, and `isMinimized`. Empty titles are retained as untitled windows.

Rust-backed snapshots may also include `activityEvents`, containing completed foreground intervals in the collector transport schema. Electron normalizes and batches these records before committing them to SQLite. Pausing or quitting the observer closes and persists the active interval. Closing and reopening an app creates a new interval; both intervals remain in the log.

Pending captures are committed in one SQLite transaction after up to one second or when 50 captures are queued. The pending batch is flushed synchronously during shutdown.

No screenshots, keystrokes, or network uploads are collected. The local API binds only to `127.0.0.1`.

## Work signals

The observer generates deterministic findings from completed foreground intervals. Findings are signals about captured activity, not conclusions about intent, and each includes evidence, an app sequence, a time range, foreground-change counts, and a short explanation of why it may matter and why it may be normal.

The current signal types are:

- `context_switch_burst` — frequent foreground app changes inside a rolling time window. Overlapping candidate windows are merged into one burst.
- `repeated_revisit` — repeated returns to the same app and window title after interruptions by other work.
- `long_focus_block` — a sustained foreground interval, presented as a neutral work pattern rather than friction.

Each finding includes a human-readable confidence label (`Strong evidence`, `Moderate evidence`, or `Weak signal`) and an impact level. The UI groups unreviewed findings into potential friction and work patterns, then places every feedback-marked card in Reviewed signals. Feedback is a separate user-owned status: `correct` renders as Confirmed, `expected` as Expected context, `incorrect` as Not a fit, and `ignore` as Dismissed. Expected and ignored findings are ranked lower. Feedback never changes the detector-owned category; it is stored in `feedback.json` and applied again when insights are regenerated. A missing or malformed feedback file safely behaves as empty feedback.

Insight detection and ranking are deterministic. No LLM key is required, and no LLM is used to create, classify, or rank Work Friction Insights.

## Local API

The Electron main process also serves localhost-only read routes at `http://127.0.0.1:47821`:

- `GET /api/activity` — returns completed foreground intervals queried from SQLite.
- `GET /api/current` — returns the capture time and foreground window from the most recent SQLite snapshot.
- `GET /api/summary` — returns compact totals aggregated from SQLite.
- `GET /api/insights` — returns deterministic work signals with categories, metrics, confidence labels, and evidence.
- `GET /api/insights/:id` — returns one work signal.
- `POST /api/insights/:id/feedback` — stores `correct`, `expected`, `incorrect`, or `ignore` feedback in `feedback.json`.
- `GET /api/personal-dashboard` — returns today’s readable work journal, repeated tasks to resume, a deterministic standup draft, and up to three active friction signals.

Feedback requests use a JSON body:

```json
{"status":"expected"}
```

Set `WINDOW_OBSERVER_API_PORT` to use a different local port. No external network interface is opened.

With the app running, verify the local API from a second terminal:

```bash
curl http://127.0.0.1:47821/api/activity
curl http://127.0.0.1:47821/api/current
curl http://127.0.0.1:47821/api/summary
curl http://127.0.0.1:47821/api/insights
curl http://127.0.0.1:47821/api/personal-dashboard
```

Switch between a few foreground apps, wait for the next capture, then repeat the commands. `activity`, `summary`, `insights`, and `personal-dashboard` should update as completed intervals are written. All routes return JSON, including validation and route errors.

## Demo flow

1. Start the app with either `npm start` (Rust) or `WINDOW_OBSERVER_COLLECTOR=js npm start` (fallback).
2. Switch among several apps, then return to one of them; wait one capture interval so the previous foreground interval closes.
3. Open **Friction insights**. A switching signal says how many **foreground changes** occurred, not how many distinct apps were used.
4. Expand a card to review its time range, app sequence, repeated app/title, and the supporting timeline. Read both why it may matter and why it may be normal.
5. Mark a card Correct, Expected, Incorrect, or Ignore. Refresh or restart the app to confirm the state remains. Expected and ignored cards rank lower; ignored cards appear as Dismissed.
6. Open **My Day** to review the merged work journal, tasks you repeatedly returned to, the deterministic standup draft, and the short personal friction summary.

Known limitations: the product observes foreground-window metadata only, cannot infer intent, and an active interval normally closes on the next capture, pause, or quit. The JS fallback relies on macOS accessibility/JXA behavior and is less reliable than the Rust collector; treat its warning as a cue to confirm the captured evidence.

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

## Rust collector

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

## Tests

Run the Node test suite with:

```bash
npm test
```

The suite covers SQLite persistence and malformed-record filtering, Rust and JS fallback interval state machines, insight detection and deduping, feedback persistence, local API errors, and renderer states. Run the Rust tests separately with:

```bash
cargo test --manifest-path rust-collector/Cargo.toml
```

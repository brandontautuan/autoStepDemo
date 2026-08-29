# Window Observer

Local Electron app that polls macOS application windows and records changes as JSON.

## Run

```bash
npm install
npm start
```

The supported deployment target for this migration is macOS. The Rust collector is selected by default on macOS. It uses JXA/AppleScript through `System Events` to enumerate windows from all accessible processes, including minimized and untitled windows. The observer’s own window is excluded. The first time you run it on macOS, click **Open Accessibility settings**, enable the app under **System Settings → Privacy & Security → Accessibility**, then restart the app. Set `WINDOW_OBSERVER_COLLECTOR=js` to force the JavaScript fallback.

## Stored data

When running with `npm start`, the app writes directly into this repository:

```text
observer-data/
```

Packaged builds use Electron’s writable `userData/observer-data` directory instead. You can also override the location with the `WINDOW_OBSERVER_DATA_DIR` environment variable.

The repository folder contains:

- `latest.json` — the most recent scan.
- `history.json` — snapshots saved whenever the open-window set changes.

Each window includes `appName`, `processName`, `title`, `windowTitle`, `processId`, `executablePath`, `isForeground`, `isVisible`, and `isMinimized`. Empty titles are retained as untitled windows.

Rust-backed snapshots may also include `activityEvents`, containing completed foreground intervals with a timestamp, application name, window title, duration in milliseconds, and platform. The existing UI ignores this additive field.

No screenshots, keystrokes, or network uploads are collected.

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

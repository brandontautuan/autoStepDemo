# Window Observer

Local Electron app that polls visible top-level Windows application windows and records changes as JSON.

## Run

```bash
npm install
npm start
```

On Windows, the app uses PowerShell to enumerate visible top-level windows. On macOS, it uses JXA/AppleScript through `System Events` to enumerate visible windows and their titles. The first time you run it on macOS, click **Open Accessibility settings**, enable the app under **System Settings → Privacy & Security → Accessibility**, then restart the app.

## Stored data

When running with `npm start`, the app writes directly into this repository:

```text
observer-data/
```

Packaged builds use Electron’s writable `userData/observer-data` directory instead. You can also override the location with the `WINDOW_OBSERVER_DATA_DIR` environment variable.

The repository folder contains:

- `latest.json` — the most recent scan.
- `history.json` — snapshots saved whenever the open-window set changes.

Each window includes `appName`, `processName`, `title`, `windowTitle`, `processId`, `executablePath`, and `isForeground`. `title` and `windowTitle` both contain the native Windows `MainWindowTitle` value so the window title is preserved explicitly in the JSON schema.

No screenshots, keystrokes, or network uploads are collected.

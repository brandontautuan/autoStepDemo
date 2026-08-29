use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use crate::model::WindowRecord;

pub fn collect(exclude_pid: Option<u32>) -> Result<Vec<WindowRecord>, String> {
    let excluded = exclude_pid.unwrap_or_default();
    if let Some(binary) = native_binary() {
        match collect_with_native(binary, excluded) {
            Ok(windows) if !windows.is_empty() => return Ok(windows),
            Ok(_) if std::env::var("WINDOW_OBSERVER_MACOS_NATIVE_ONLY").as_deref() == Ok("1") => {
                return Err(
                    "native macOS collector returned no windows; check Accessibility permission"
                        .into(),
                );
            }
            Err(error)
                if std::env::var("WINDOW_OBSERVER_MACOS_NATIVE_ONLY").as_deref() == Ok("1") =>
            {
                return Err(error);
            }
            _ => {}
        }
    }
    collect_with_jxa(excluded)
}

fn native_binary() -> Option<String> {
    if let Ok(path) = std::env::var("WINDOW_OBSERVER_MACOS_NATIVE_BINARY") {
        return Some(path);
    }
    let candidate = Path::new("rust-collector/target/debug/macos-native-collector");
    candidate
        .exists()
        .then(|| candidate.to_string_lossy().into_owned())
}

struct NativeCollector {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

static NATIVE_COLLECTOR: OnceLock<Mutex<Option<NativeCollector>>> = OnceLock::new();

fn collect_with_native(binary: String, excluded: u32) -> Result<Vec<WindowRecord>, String> {
    let slot = NATIVE_COLLECTOR.get_or_init(|| Mutex::new(None));
    let mut guard = slot.lock().map_err(|_| "native collector lock poisoned")?;
    if guard.is_none() {
        let mut child = Command::new(binary)
            .arg(excluded.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("native collector stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("native collector stdout unavailable")?;
        *guard = Some(NativeCollector { child, stdin, stdout: BufReader::new(stdout) });
    }
    let result = (|| {
        let collector = guard.as_mut().ok_or("native collector unavailable")?;
        collector.stdin.write_all(b"capture\n").map_err(|error| error.to_string())?;
        collector.stdin.flush().map_err(|error| error.to_string())?;
        let mut line = String::new();
        collector.stdout.read_line(&mut line).map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            return Err("native macOS helper exited before responding".into());
        }
        let response: serde_json::Value = serde_json::from_str(line.trim()).map_err(|error| error.to_string())?;
        serde_json::from_value(response["windows"].clone()).map_err(|error| error.to_string())
    })();
    if result.is_err() {
        if let Some(collector) = guard.as_mut() {
            let _ = collector.child.kill();
            let _ = collector.child.wait();
        }
        *guard = None;
    }
    result
}

fn collect_with_jxa(excluded: u32) -> Result<Vec<WindowRecord>, String> {
    let script = format!(
        r#"
        const systemEvents = Application('System Events');
        const rows = [];
        for (const process of systemEvents.processes()) {{
          try {{
            const appName = process.name();
            const processId = process.unixId();
            if (processId === {excluded}) continue;
            const isVisible = Boolean(process.visible());
            const isForeground = Boolean(process.frontmost());
            for (const window of process.windows()) {{
              try {{
                const title = window.name() || '';
                let isMinimized = false;
                try {{ isMinimized = Boolean(window.attributes.byName('AXMinimized').value()); }} catch (_) {{}}
                rows.push({{ appName, processName: appName, title, windowTitle: title, processId, executablePath: '', isForeground, isVisible, isMinimized }});
              }} catch (_) {{}}
            }}
          }} catch (_) {{}}
        }}
        JSON.stringify(rows);
        "#
    );

    let output = Command::new("/usr/bin/osascript")
        .args(["-l", "JavaScript", "-e", &script])
        .output()
        .map_err(|error| format!("could not start osascript: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid osascript JSON: {error}"))
}

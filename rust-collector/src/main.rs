mod model;
mod platform;

use std::env;
use std::io::{self, BufRead, Write};
use std::process::ExitCode;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use model::{ActivityEvent, CollectorResponse, WindowRecord};

fn usage() {
    eprintln!("Usage: window-observer-collector [--once] [--exclude-pid PID]");
}

fn exclude_pid(args: &[String]) -> Option<u32> {
    args.windows(2)
        .find(|pair| pair[0] == "--exclude-pid")
        .and_then(|pair| pair[1].parse::<u32>().ok())
}

struct ActivityState {
    active_key: Option<String>,
    active_since: Option<SystemTime>,
}

impl ActivityState {
    fn new() -> Self {
        Self {
            active_key: None,
            active_since: None,
        }
    }

    fn update(&mut self, windows: &[WindowRecord]) -> Vec<ActivityEvent> {
        let active = windows.iter().find(|window| window.is_foreground);
        let next_key = active.map(|window| {
            format!(
                "{}:{}:{}",
                window.process_id, window.app_name, window.window_title
            )
        });
        if next_key == self.active_key {
            return Vec::new();
        }

        let now = SystemTime::now();
        let mut events = Vec::new();
        if let (Some(previous_key), Some(started)) = (&self.active_key, self.active_since) {
            if let Some((process_id, app_name, window_title)) = previous_key
                .split_once(':')
                .and_then(|(pid, rest)| rest.split_once(':').map(|(app, title)| (pid, app, title)))
            {
                events.push(ActivityEvent {
                    timestamp: unix_millis(now),
                    app_name: app_name.to_string(),
                    window_title: window_title.to_string(),
                    duration_ms: now
                        .duration_since(started)
                        .unwrap_or(Duration::ZERO)
                        .as_millis(),
                    platform: if cfg!(target_os = "macos") {
                        "darwin"
                    } else {
                        "windows"
                    }
                    .to_string(),
                });
                let _ = process_id;
            }
        }
        self.active_key = next_key;
        self.active_since = self.active_key.as_ref().map(|_| now);
        events
    }
}

fn unix_millis(time: SystemTime) -> u128 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO)
        .as_millis()
}

fn collect_once(excluded: Option<u32>, activity: &mut ActivityState) -> Result<(), String> {
    let windows = platform::collect(excluded)?;
    let response = CollectorResponse {
        activity_events: activity.update(&windows),
        windows,
    };
    println!(
        "{}",
        serde_json::to_string(&response).map_err(|error| error.to_string())?
    );
    io::stdout().flush().map_err(|error| error.to_string())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        usage();
        return Ok(());
    }
    let excluded = exclude_pid(&args);
    let mut activity = ActivityState::new();
    if args.iter().any(|arg| arg == "--once") {
        return collect_once(excluded, &mut activity);
    }

    for command in io::stdin().lock().lines() {
        match command.map_err(|error| error.to_string())?.trim() {
            "capture" => collect_once(excluded, &mut activity)?,
            "shutdown" => break,
            "" => {}
            _ => eprintln!("window-observer-collector: unknown command"),
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("window-observer-collector: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ActivityState;
    use crate::model::WindowRecord;
    use std::time::{Duration, SystemTime};

    fn window(app_name: &str, title: &str, process_id: u32, is_foreground: bool) -> WindowRecord {
        WindowRecord {
            app_name: app_name.into(),
            process_name: app_name.into(),
            title: title.into(),
            window_title: title.into(),
            process_id,
            executable_path: String::new(),
            is_foreground,
            is_visible: true,
            is_minimized: false,
        }
    }

    #[test]
    fn emits_a_completed_activity_interval_when_foreground_changes() {
        let mut state = ActivityState {
            active_key: Some("1:Editor:Draft".into()),
            active_since: Some(SystemTime::now() - Duration::from_millis(10)),
        };
        let events = state.update(&[window("Browser", "Home", 2, true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].app_name, "Editor");
        assert!(events[0].duration_ms >= 10);
    }
}

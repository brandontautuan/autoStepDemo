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
    active_window: Option<WindowRecord>,
    active_since: Option<SystemTime>,
}

impl ActivityState {
    fn new() -> Self {
        Self {
            active_window: None,
            active_since: None,
        }
    }

    fn update(&mut self, windows: &[WindowRecord]) -> Vec<ActivityEvent> {
        let active = windows.iter().find(|window| window.is_foreground);
        let next_window = active.cloned();
        let same_window = self
            .active_window
            .as_ref()
            .zip(next_window.as_ref())
            .is_some_and(|(old, new)| {
                old.process_id == new.process_id
                    && old.app_name == new.app_name
                    && old.window_title == new.window_title
            });
        if same_window || self.active_window.is_none() && next_window.is_none() {
            return Vec::new();
        }

        let now = SystemTime::now();
        let mut events = Vec::new();
        if let (Some(previous), Some(started)) = (&self.active_window, self.active_since) {
            events.push(ActivityEvent {
                timestamp: unix_millis(now),
                app_name: previous.app_name.clone(),
                window_title: previous.window_title.clone(),
                process_id: previous.process_id,
                process_name: previous.process_name.clone(),
                path: previous.executable_path.clone(),
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
        }
        self.active_window = next_window;
        self.active_since = self.active_window.as_ref().map(|_| now);
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
            active_window: Some(window("Editor", "Draft", 1, true)),
            active_since: Some(SystemTime::now() - Duration::from_millis(10)),
        };
        let events = state.update(&[window("Browser", "Home", 2, true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].app_name, "Editor");
        assert_eq!(events[0].process_id, 1);
        assert!(events[0].duration_ms >= 10);
    }

    #[test]
    fn reopening_an_app_starts_a_new_interval_when_the_process_id_changes() {
        let mut state = ActivityState {
            active_window: Some(window("Safari", "Home", 1, true)),
            active_since: Some(SystemTime::now() - Duration::from_millis(10)),
        };
        let events = state.update(&[window("Safari", "Home", 2, true)]);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].process_id, 1);
        assert_eq!(
            state.active_window.as_ref().map(|item| item.process_id),
            Some(2)
        );
        assert!(state.active_since.is_some());
    }
}

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WindowRecord {
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "processName")]
    pub process_name: String,
    pub title: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "processId")]
    pub process_id: u32,
    #[serde(rename = "executablePath")]
    pub executable_path: String,
    #[serde(rename = "isForeground")]
    pub is_foreground: bool,
    #[serde(rename = "isVisible")]
    pub is_visible: bool,
    #[serde(rename = "isMinimized")]
    pub is_minimized: bool,
}

#[derive(Debug, Serialize)]
pub struct CollectorResponse {
    pub windows: Vec<WindowRecord>,
    #[serde(rename = "activityEvents")]
    pub activity_events: Vec<ActivityEvent>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct ActivityEvent {
    pub timestamp: u128,
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "windowTitle")]
    pub window_title: String,
    #[serde(rename = "durationMs")]
    pub duration_ms: u128,
    pub platform: String,
}

#[cfg(test)]
mod tests {
    use super::{CollectorResponse, WindowRecord};

    #[test]
    fn serializes_the_existing_window_schema() {
        let response = CollectorResponse {
            windows: vec![WindowRecord {
                app_name: "Editor".into(),
                process_name: "editor".into(),
                title: "Untitled".into(),
                window_title: "Untitled".into(),
                process_id: 42,
                executable_path: String::new(),
                is_foreground: false,
                is_visible: true,
                is_minimized: false,
            }],
            activity_events: Vec::new(),
        };

        let json = serde_json::to_value(response).expect("schema should serialize");
        assert_eq!(json["windows"][0]["appName"], "Editor");
        assert_eq!(json["windows"][0]["windowTitle"], "Untitled");
        assert_eq!(json["windows"][0]["processId"], 42);
        assert_eq!(json["windows"][0]["isMinimized"], false);
    }
}

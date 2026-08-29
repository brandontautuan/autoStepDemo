use std::process::Command;

use crate::model::WindowRecord;

pub fn collect(exclude_pid: Option<u32>) -> Result<Vec<WindowRecord>, String> {
    let excluded = exclude_pid.unwrap_or_default();
    let script = format!(
        r#"
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class WindowObserverNative {{
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr extraData);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}}
"@
$observerPid = {excluded}
$rows = @()
[WindowObserverNative]::EnumWindows({{ param($handle, $unused); $pid = 0; [WindowObserverNative]::GetWindowThreadProcessId($handle, [ref]$pid) | Out-Null; if ($pid -eq $observerPid) {{ return $true }}; $titleBuffer = New-Object Text.StringBuilder 1024; [WindowObserverNative]::GetWindowText($handle, $titleBuffer, 1024) | Out-Null; $process = Get-Process -Id $pid -ErrorAction SilentlyContinue; if ($null -ne $process) {{ $rows += [PSCustomObject]@{{ appName=if ($process.Description) {{ $process.Description }} else {{ $process.ProcessName }}; processName=$process.ProcessName; title=$titleBuffer.ToString(); windowTitle=$titleBuffer.ToString(); processId=$pid; executablePath=$process.Path; isForeground=$false; isVisible=[WindowObserverNative]::IsWindowVisible($handle); isMinimized=[WindowObserverNative]::IsIconic($handle) }} }}; return $true }}, [IntPtr]::Zero) | Out-Null
$rows | ConvertTo-Json -Depth 3 -Compress
"#
    );

    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|error| format!("could not start powershell.exe: {error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    if output.stdout.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(Vec::new());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid PowerShell JSON: {error}"))?;
    match value {
        serde_json::Value::Array(_) => {
            serde_json::from_value(value).map_err(|error| error.to_string())
        }
        value => Ok(vec![
            serde_json::from_value(value).map_err(|error| error.to_string())?
        ]),
    }
}

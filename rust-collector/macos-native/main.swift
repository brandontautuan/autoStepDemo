import AppKit
import CoreGraphics
import Foundation
import Darwin

struct WindowRecord: Codable {
    let appName: String
    let processName: String
    let title: String
    let windowTitle: String
    let processId: Int32
    let executablePath: String
    let isForeground: Bool
    let isVisible: Bool
    let isMinimized: Bool
}

struct Response: Codable {
    let windows: [WindowRecord]
}

func collect(excludedPid: Int32) -> [WindowRecord] {
    var rows: [WindowRecord] = []
    guard let windowList = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return rows }
    for info in windowList {
        guard let pidNumber = info[kCGWindowOwnerPID as String] as? NSNumber else { continue }
        let pid = pidNumber.int32Value
        if pid == excludedPid { continue }
        if let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue, layer != 0 { continue }

        let application = NSRunningApplication(processIdentifier: pid)
        let appName = (info[kCGWindowOwnerName as String] as? String) ?? application?.localizedName ?? "Unknown app"
        let executablePath = application?.executableURL?.path ?? ""
        let title = (info[kCGWindowName as String] as? String) ?? ""
        let isVisible = (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false
        if !isVisible { continue }
        rows.append(WindowRecord(
            appName: appName,
            processName: appName,
            title: title,
            windowTitle: title,
            processId: pid,
            executablePath: executablePath,
            isForeground: application?.isActive ?? false,
            isVisible: isVisible,
            isMinimized: false
        ))
    }
    return rows
}

let excludedPid = Int32(CommandLine.arguments.dropFirst().first ?? "0") ?? 0
let encoder = JSONEncoder()
if CommandLine.arguments.contains("--once") {
    let response = Response(windows: collect(excludedPid: excludedPid))
    if let data = try? encoder.encode(response), let output = String(data: data, encoding: .utf8) {
        print(output)
    }
    exit(0)
}
while let command = readLine() {
    switch command.trimmingCharacters(in: .whitespacesAndNewlines) {
    case "capture":
        let response = Response(windows: collect(excludedPid: excludedPid))
        if let data = try? encoder.encode(response), let output = String(data: data, encoding: .utf8) {
            print(output)
            fflush(stdout)
        }
    case "shutdown":
        exit(0)
    default:
        fputs("macos-native-collector: unknown command\n", stderr)
    }
}

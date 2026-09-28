// ============================================================
// simmer-fg-probe · macOS 前台应用与空闲探针
//
// 对应 Windows 采集器的 NativeMethods.cs：
//   GetForegroundProcessName() → frontmostAppName()
//   GetLastInputInfo()         → idleMilliseconds()
//
// 每 N 秒向 stdout 输出一行 NDJSON 采样，由 Node 采集器按分钟聚合：
//   {"app":"Safari","idle":false,"idleMs":812,"locked":false}
//
// 使用的都是 macOS 官方 API，均不需要辅助功能 / 屏幕录制等授权：
//   - 前台应用：CGWindowListCopyWindowInfo（实时查询，避免长驻进程取值冻结），
//               并以 NSWorkspace.frontmostApplication 兜底
//   - 键鼠空闲：CGEventSource.secondsSinceLastEventType
//   - 锁屏状态：CGSessionCopyCurrentDictionary
//
// 用法：simmer-fg-probe [--interval 2] [--idle-threshold-minutes 5]
// ============================================================
import AppKit
import CoreGraphics
import Foundation

let VERSION = "1.0.0"

/* ---------- 参数 ---------- */
var intervalSeconds = 2.0
var idleThresholdMinutes = 5.0

var args = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < args.count {
    switch args[index] {
    case "--interval":
        if index + 1 < args.count, let value = Double(args[index + 1]), value > 0 {
            intervalSeconds = value
            index += 1
        }
    case "--idle-threshold-minutes":
        if index + 1 < args.count, let value = Double(args[index + 1]), value > 0 {
            idleThresholdMinutes = value
            index += 1
        }
    case "--version":
        print(VERSION)
        exit(0)
    default:
        break
    }
    index += 1
}

/* ---------- 前台应用名 ----------
 * 优先取 .app 包名（如 "Safari" / "Visual Studio Code"）：跨语言环境稳定，
 * 白名单不会因切换系统语言而失效；包名缺失时退回本地化名、最后退回可执行名。
 * 与 Windows 端「前台进程 exe 文件名」的粒度一致。
 */
func appName(_ app: NSRunningApplication) -> String? {
    if let bundleURL = app.bundleURL {
        let name = bundleURL.deletingPathExtension().lastPathComponent
        if !name.isEmpty { return name }
    }
    if let localized = app.localizedName, !localized.isEmpty { return localized }
    if let executable = app.executableURL?.lastPathComponent, !executable.isEmpty { return executable }
    return nil
}

/// 通过窗口服务器实时查询最前台的应用。
///
/// 为什么不直接用 NSWorkspace.frontmostApplication：该属性依赖 NSWorkspace 接收
/// 分布式通知来更新缓存，而本探针是无 run loop 的长驻进程——实测连续运行数日后
/// 取值会**冻结**在启动时的那个应用上（日志里表现为 6 天每分钟都记同一个软件）。
/// CGWindowListCopyWindowInfo 每次调用都向窗口服务器实时查询，不依赖通知，
/// 因此能持续跟踪前台切换；只取窗口层 layer 0（普通窗口），跳过菜单栏等浮层。
func frontmostAppViaWindowList() -> NSRunningApplication? {
    guard let windows = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return nil }
    for window in windows {
        guard let layer = window[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = window[kCGWindowOwnerPID as String] as? pid_t, pid > 0 else { continue }
        if let app = NSRunningApplication(processIdentifier: pid) { return app }
    }
    return nil
}

/// 前台应用名。
///
/// 主用 NSWorkspace.frontmostApplication：语义最准（前台应用即使没有可见窗口也能
/// 正确识别）。但它依赖 run loop 接收“前台应用变化”的分布式通知——本探针原先用
/// Thread.sleep 轮询、没有 run loop，实测长驻数日后取值会**冻结**在启动时的那个应用
/// 上（日志表现为连续 6 天每分钟都记同一个软件）。主循环因此改为 RunLoop 驱动。
///
/// CGWindowListCopyWindowInfo 作为兜底：每次调用都实时查询窗口服务器、不依赖通知，
/// 用于 NSWorkspace 取不到值的情况。
func frontmostAppName() -> String? {
    if let app = NSWorkspace.shared.frontmostApplication, let name = appName(app) {
        return name
    }
    if let app = frontmostAppViaWindowList(), let name = appName(app) { return name }
    return nil
}

/* ---------- 键鼠空闲毫秒数 ----------
 * kCGAnyInputEventType == ~0，combinedSessionState 覆盖本机所有输入源。
 */
func idleMilliseconds() -> Double {
    let anyInputEventType = CGEventType(rawValue: ~0)!
    let seconds = CGEventSource.secondsSinceLastEventType(
        .combinedSessionState, eventType: anyInputEventType)
    if seconds <= 0 { return 0 }
    return seconds * 1000.0
}

/* ---------- 锁屏 / 登录窗口 ---------- */
func isScreenLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let locked = session["CGSSessionScreenIsLocked"] as? Bool { return locked }
    if let onConsole = session["kCGSSessionOnConsoleKey"] as? Bool, !onConsole { return true }
    return false
}

func jsonEscape(_ value: String) -> String {
    var out = ""
    for character in value.unicodeScalars {
        switch character {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if character.value < 0x20 {
                out += String(format: "\\u%04x", character.value)
            } else {
                out.unicodeScalars.append(character)
            }
        }
    }
    return out
}

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/* ---------- 主循环 ---------- */
let idleThresholdMs = idleThresholdMinutes * 60_000.0
emit("{\"type\":\"hello\",\"version\":\"\(VERSION)\",\"intervalSeconds\":\(intervalSeconds)}")

/// 采样一次并输出。用 RunLoop + Timer 驱动（而非 Thread.sleep 轮询），
/// 使进程能持续处理 NSWorkspace 的前台应用变化通知，避免长驻取值冻结。
func sampleAndEmit() {
    let idleMs = idleMilliseconds()
    let locked = isScreenLocked()
    let app = locked ? nil : frontmostAppName()
    // 与 Windows 一致：空闲超过阈值或锁屏的采样不归属任何软件
    let idle = locked || idleMs > idleThresholdMs

    let appField = app.map { "\"\(jsonEscape($0))\"" } ?? "null"
    emit("{\"app\":\(appField),\"idle\":\(idle ? "true" : "false"),"
        + "\"idleMs\":\(Int(idleMs)),\"locked\":\(locked ? "true" : "false")}")
}

sampleAndEmit()                       // 启动后立即采一次，便于上层尽快拿到状态
let timer = Timer(timeInterval: intervalSeconds, repeats: true) { _ in
    sampleAndEmit()
}
RunLoop.main.add(timer, forMode: .common)
RunLoop.main.run()

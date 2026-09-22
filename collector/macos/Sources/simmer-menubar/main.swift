// ============================================================
// simmer-menubar · Jitang Simmer 菜单栏状态图标
//
// 采集器在后台静默运行（无窗口），此前无法一眼看出是否在工作。
// 本程序在菜单栏常驻一个图标，显示采集器状态并提供常用操作：
//   · 图标实心 = 采集器运行中，空心 = 已停止
//   · 菜单显示运行模式、上报地址、最近上报时间、待上报队列
//   · 可打开面板 / 查看日志 / 启动 / 停止 / 重启采集器
//
// 作为 LSUIElement（附件应用）运行：只在菜单栏出现，不占 Dock 与程序切换器。
// ============================================================
import AppKit
import Foundation

/* ---------- 路径 ---------- */
let home = FileManager.default.homeDirectoryForCurrentUser
let stateDir = home.appendingPathComponent("Library/Application Support/SimmerCollector")
let lockFile = stateDir.appendingPathComponent("collector.lock")
let usageQueue = stateDir.appendingPathComponent("usage-queue.json")
let hardwareQueue = stateDir.appendingPathComponent("hardware-queue.json")
let collectorLog = stateDir.appendingPathComponent("mac-collector.log")
let launchLabel = "io.jitang.simmer.collector"

/// 安装根目录：从可执行文件所在位置向上查找含 collector/macos 的目录，
/// 不依赖 .app 的固定层级（放在安装根或 collector/macos 下都能正确定位）
let installRoot: URL = {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    var candidate = executable.deletingLastPathComponent()
    let manager = FileManager.default
    for _ in 0..<8 {
        let marker = candidate.appendingPathComponent("collector/macos/simmer-collector.js")
        if manager.fileExists(atPath: marker.path) { return candidate }
        let parent = candidate.deletingLastPathComponent()
        if parent.path == candidate.path { break }
        candidate = parent
    }
    // 兜底：按 <root>/xxx.app/Contents/MacOS/exe 的三层上溯
    return executable
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}()
let collectorConfig = installRoot.appendingPathComponent("collector/macos/collector-config.json")

/* ---------- 小工具 ---------- */
func run(_ launchPath: String, _ arguments: [String]) -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: launchPath)
    process.arguments = arguments
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = Pipe()
    do { try process.run() } catch { return (-1, "") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(data: data, encoding: .utf8) ?? "")
}

func readJSON(_ url: URL) -> [String: Any]? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func queueCount(_ url: URL) -> Int {
    guard let data = try? Data(contentsOf: url),
          let rows = (try? JSONSerialization.jsonObject(with: data)) as? [Any] else { return 0 }
    return rows.count
}

/// 采集器进程号：优先用锁文件，再用 pgrep 兜底，并校验确实是采集器进程
func collectorPid() -> Int? {
    if let lock = readJSON(lockFile), let pid = lock["pid"] as? Int, pid > 0 {
        if processIsCollector(pid) { return pid }
    }
    // 用带路径的模式，降低“命令行里恰好提到该文件名”的误判概率
    let result = run("/usr/bin/pgrep", ["-f", "collector/macos/simmer-collector\\.js"])
    if let first = result.output.split(separator: "\n").first, let pid = Int(first),
       processIsCollector(pid) { return pid }
    return nil
}

func processIsCollector(_ pid: Int) -> Bool {
    if kill(Int32(pid), 0) != 0 && errno == ESRCH { return false }
    let result = run("/bin/ps", ["-o", "command=", "-p", String(pid)])
    // 校验完整路径，避免仅提到文件名的无关进程被当成采集器
    return result.output.contains("collector/macos/simmer-collector.js")
}

/// 从采集日志里取最近一条上报时间
func lastUploadText() -> String? {
    guard let text = try? String(contentsOf: collectorLog, encoding: .utf8) else { return nil }
    let lines = text.split(separator: "\n").suffix(400)
    for line in lines.reversed() {
        if line.contains("上报成功") || line.contains("心跳已发送") {
            // 形如 [2026-09-22T10:00:40.477Z] 设备心跳已发送...
            if let close = line.firstIndex(of: "]") {
                let stamp = line[line.index(after: line.startIndex)..<close]
                let time = stamp.split(separator: "T").last.map { String($0.prefix(8)) } ?? String(stamp)
                let body = line[line.index(after: close)...].trimmingCharacters(in: .whitespaces)
                return "\(time)  \(body)"
            }
            return String(line)
        }
    }
    return nil
}

func serverInfo() -> (mode: String, server: String, dashboard: String?) {
    guard let config = readJSON(collectorConfig) else { return ("本机模式", "http://127.0.0.1:8788", nil) }
    let server = (config["serverUrl"] as? String) ?? ""
    let dashboard = config["dashboardUrl"] as? String
    let isLocal = server.isEmpty || server.contains("127.0.0.1") || server.contains("localhost")
    return (isLocal ? "本机模式" : "聚合模式", server, dashboard)
}

/// 写调试日志（排查 launchd 启动时的单实例误判）
func debugLog(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "[\(stamp)] \(message)\n"
    let url = stateDir.appendingPathComponent("menubar.log")
    try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: url) {
        handle.seekToEndOfFile()
        handle.write(Data(line.utf8))
        try? handle.close()
    } else {
        try? line.write(to: url, atomically: true, encoding: .utf8)
    }
}

/// 是否已有其它 simmer-menubar 进程在运行
func anotherInstanceRunning() -> Bool {
    let myPid = Int(ProcessInfo.processInfo.processIdentifier)
    // 必须用 -x 精确匹配进程名：-f 会匹配整条命令行，任何“命令行里含
    // simmer-menubar 字样”的无关进程（如正在查看源码的终端）都会被误判成另一个实例
    let result = run("/usr/bin/pgrep", ["-x", "simmer-menubar"])
    let others = result.output.split(separator: "\n").compactMap { Int($0) }.filter { $0 != myPid }
    if !others.isEmpty {
        let details = others.map { pid -> String in
            let cmd = run("/bin/ps", ["-o", "command=", "-p", String(pid)]).output
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return "\(pid): \(cmd)"
        }.joined(separator: " | ")
        debugLog("检测到其它实例 → \(details)")
    }
    return !others.isEmpty
}

/// 单实例：直接运行二进制时（LaunchAgent 即如此）可能起出第二个图标。
/// 升级安装时旧实例可能尚未退出，因此这里短暂重试等待，而不是立刻放弃。
func waitUntilSingleInstance(timeout: TimeInterval = 4.0) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    repeat {
        if !anotherInstanceRunning() { return true }
        Thread.sleep(forTimeInterval: 0.4)
    } while Date() < deadline
    return false
}

/* ---------- 应用 ---------- */
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 已有图标在运行时本实例退出（退出码 0 → launchd 不会反复重启）。
        // 升级安装时旧实例可能正在退出，因此等待若干秒再判定。
        debugLog("启动：pid=\(ProcessInfo.processInfo.processIdentifier) argv=\(CommandLine.arguments.joined(separator: " "))")
        if !waitUntilSingleInstance() {
            debugLog("等待超时，判定已有实例在运行，本实例退出")
            NSApp.terminate(nil)
            return
        }
        debugLog("单实例检查通过，创建菜单栏图标")
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.behavior = .removalAllowed
        refresh()
        // 每 5 秒刷新一次状态
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    /* ---------- 图标与菜单 ---------- */
    private func refresh() {
        let running = collectorPid() != nil
        updateIcon(running: running)
        statusItem.menu = buildMenu(running: running)
    }

    private func updateIcon(running: Bool) {
        guard let button = statusItem.button else { return }
        let symbolName = running ? "chart.bar.fill" : "chart.bar"
        if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: "Jitang Simmer") {
            image.isTemplate = true
            button.image = image
            button.title = ""
        } else {
            // 兜底：系统符号不可用时手绘一个柱状图标，避免出现空白图标
            button.image = fallbackImage(running: running)
            button.title = ""
        }
        button.toolTip = running ? "Jitang Simmer：采集器运行中" : "Jitang Simmer：采集器已停止"
        button.appearsDisabled = !running
    }

    /// 手绘兜底图标：三根柱子，停止时整体变矮
    private func fallbackImage(running: Bool) -> NSImage {
        let size = NSSize(width: 18, height: 14)
        let image = NSImage(size: size, flipped: false) { _ in
            NSColor.black.setFill()
            let bars: [(CGFloat, CGFloat)] = [(1, 6), (7, 10), (13, 14)]
            for (x, height) in bars {
                let barHeight = running ? height : height * 0.55
                NSRect(x: x, y: 0, width: 4, height: barHeight).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    private func buildMenu(running: Bool) -> NSMenu {
        let menu = NSMenu()
        let info = serverInfo()

        // 状态标题
        let statusItemRow = NSMenuItem()
        statusItemRow.attributedTitle = NSAttributedString(
            string: running ? "● 采集器运行中" : "○ 采集器已停止",
            attributes: [
                .font: NSFont.boldSystemFont(ofSize: 13),
                .foregroundColor: running ? NSColor.systemGreen : NSColor.secondaryLabelColor,
            ])
        menu.addItem(statusItemRow)

        menu.addItem(withTitle: "运行模式：\(info.mode)", action: nil, keyEquivalent: "")
        menu.addItem(withTitle: "上报地址：\(info.server)", action: nil, keyEquivalent: "")

        if running, let pid = collectorPid() {
            menu.addItem(withTitle: "进程号：\(pid)", action: nil, keyEquivalent: "")
        }
        let usage = queueCount(usageQueue)
        let hardware = queueCount(hardwareQueue)
        menu.addItem(withTitle: "待上报：\(usage) 分钟 / \(hardware) 硬件", action: nil, keyEquivalent: "")
        if let last = lastUploadText() {
            menu.addItem(withTitle: "最近上报：\(last.prefix(46))", action: nil, keyEquivalent: "")
        }
        menu.addItem(.separator())

        // 操作
        if let dashboard = info.dashboard, let url = URL(string: dashboard) {
            add(menu, "打开面板", #selector(openDashboard), represented: url.absoluteString)
        } else if let url = URL(string: "http://127.0.0.1:8788/index.html") {
            add(menu, "打开本机面板", #selector(openDashboard), represented: url.absoluteString)
        }
        add(menu, "打开日志目录", #selector(openLogs))
        menu.addItem(.separator())

        if running {
            add(menu, "停止采集", #selector(stopCollector))
            add(menu, "重启采集器", #selector(restartCollector))
        } else {
            add(menu, "启动采集", #selector(startCollector))
        }
        menu.addItem(.separator())

        add(menu, "在访达中显示应用", #selector(revealApp))
        add(menu, "退出菜单栏图标", #selector(quit))
        return menu
    }

    private func add(_ menu: NSMenu, _ title: String, _ selector: Selector, represented: String? = nil) {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self
        if let represented { item.representedObject = represented }
        menu.addItem(item)
    }

    /* ---------- 动作 ---------- */
    @objc private func openDashboard(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String, let url = URL(string: text) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openLogs() {
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(stateDir)
    }

    @objc private func startCollector() {
        let uid = getuid()
        let result = run("/bin/launchctl", ["kickstart", "gui/\(uid)/\(launchLabel)"])
        if result.status != 0 {
            // 兜底：直接运行开机自启脚本
            let script = installRoot.appendingPathComponent("collector/macos/autostart-run.sh").path
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = [script]
            try? task.run()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }

    @objc private func stopCollector() {
        if let pid = collectorPid() { kill(Int32(pid), SIGTERM) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.refresh() }
    }

    @objc private func restartCollector() {
        if let pid = collectorPid() { kill(Int32(pid), SIGTERM) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) { [weak self] in
            self?.startCollector()
        }
    }

    @objc private func revealApp() {
        NSWorkspace.shared.activateFileViewerSelecting([installRoot])
    }

    @objc private func quit() {
        // 只退出菜单栏图标本身，不影响采集器
        NSApp.terminate(nil)
    }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()

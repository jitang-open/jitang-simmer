// ============================================================
// simmer-hw-probe · macOS 硬件指标探针
//
// 对应 Windows 采集器的 HardwareMonitor.cs（LibreHardwareMonitor 适配层），
// 输出与 POST /api/hardware-samples 完全一致的分钟级快照：
//   {"t":"yyyy-MM-ddTHH:mm","cpu":%,"gpu":%,"mem":%,"vram":%,
//    "cpuTemp":°C,"gpuTemp":°C,"power":W,"disk":%}
// 字段允许为 null——某项不可用时不得影响其余指标（与 Windows 端约定一致）。
//
// 各指标的 macOS 取值来源（全部免密、无需授权）：
//   cpu      Mach host_statistics(HOST_CPU_LOAD_INFO) 时间片增量 → 区间平均占用
//   mem      Mach host_statistics64(HOST_VM_INFO64) + sysctl hw.memsize
//   disk     statfs("/")
//   gpu      IOKit IOAccelerator.PerformanceStatistics["Device Utilization %"]
//   vram     IOKit IOAccelerator.PerformanceStatistics 已用/已分配显存
//   cpuTemp  尝试 SMC(AppleSMC) 读取；Apple Silicon 无该服务 → null
//   gpuTemp  同上
//   power    同上（Apple Silicon 需 powermetrics，而它必须 root）
//
// 用法：simmer-hw-probe [--interval 60]
// ============================================================
import Darwin
import Foundation
import IOKit

let VERSION = "1.0.0"

/* ---------- 参数 ---------- */
var intervalSeconds = 60.0
var args = Array(CommandLine.arguments.dropFirst())
var index = 0
while index < args.count {
    switch args[index] {
    case "--interval":
        if index + 1 < args.count, let value = Double(args[index + 1]), value > 0 {
            intervalSeconds = value
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

/* ---------- 数值归一（对应 Windows 的 Normalize/Percent/Temperature/Watts） ---------- */
func normalize(_ value: Double?, min: Double, max: Double) -> Double? {
    guard let value, value.isFinite, value >= min, value <= max else { return nil }
    return (value * 10).rounded() / 10
}

let percent = { (value: Double?) in normalize(value, min: 0, max: 100) }
// 运行中的 CPU/GPU 不可能稳定为 0°C；部分来源用 0 表示“无读数”
let temperature = { (value: Double?) in normalize(value, min: 1, max: 150) }
let watts = { (value: Double?) in normalize(value, min: 0, max: 5000) }

/* ---------- CPU 占用（时间片增量） ---------- */
struct CPUTicks {
    let user: UInt32, system: UInt32, idle: UInt32, nice: UInt32
    var busy: Double { Double(user) + Double(system) + Double(nice) }
    var total: Double { busy + Double(idle) }
}

func cpuTicks() -> CPUTicks? {
    var info = host_cpu_load_info_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<host_cpu_load_info_data_t>.stride / MemoryLayout<integer_t>.stride)
    let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count)
        }
    }
    guard result == KERN_SUCCESS else { return nil }
    return CPUTicks(user: info.cpu_ticks.0, system: info.cpu_ticks.1,
                    idle: info.cpu_ticks.2, nice: info.cpu_ticks.3)
}

/// 两个时间点之间的平均占用率；计数器回绕或间隔为 0 时返回 nil
func cpuLoad(from previous: CPUTicks, to current: CPUTicks) -> Double? {
    let totalDelta = current.total - previous.total
    let busyDelta = current.busy - previous.busy
    guard totalDelta > 0, busyDelta >= 0, busyDelta <= totalDelta else { return nil }
    return busyDelta / totalDelta * 100
}

/* ---------- 内存占用 ---------- */
func totalMemoryBytes() -> Double? {
    var size: UInt64 = 0
    var length = MemoryLayout<UInt64>.size
    guard sysctlbyname("hw.memsize", &size, &length, nil, 0) == 0, size > 0 else { return nil }
    return Double(size)
}

/// 与「活动监视器」口径相近：活跃 + 联动(wired) + 压缩内存
func memoryLoad() -> Double? {
    var stats = vm_statistics64_data_t()
    var count = mach_msg_type_number_t(
        MemoryLayout<vm_statistics64_data_t>.stride / MemoryLayout<integer_t>.stride)
    let result = withUnsafeMutablePointer(to: &stats) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            host_statistics64(mach_host_self(), HOST_VM_INFO64, $0, &count)
        }
    }
    guard result == KERN_SUCCESS, let total = totalMemoryBytes() else { return nil }
    var pageSize: vm_size_t = 0
    guard host_page_size(mach_host_self(), &pageSize) == KERN_SUCCESS else { return nil }
    let usedPages = Double(stats.active_count) + Double(stats.wire_count) +
        Double(stats.compressor_page_count)
    let used = usedPages * Double(pageSize)
    guard used > 0, used <= total else { return nil }
    return used / total * 100
}

/* ---------- 磁盘占用（根卷） ---------- */
func diskLoad() -> Double? {
    var stats = statfs()
    guard statfs("/", &stats) == 0 else { return nil }
    let total = Double(stats.f_blocks) * Double(stats.f_bsize)
    let free = Double(stats.f_bfree) * Double(stats.f_bsize)
    guard total > 0, free >= 0, free <= total else { return nil }
    return (total - free) / total * 100
}

/* ---------- GPU / 显存（IOKit IOAccelerator） ---------- */
func numberValue(_ value: Any?) -> Double? {
    if let number = value as? NSNumber { return number.doubleValue }
    if let value = value as? Double { return value }
    if let value = value as? Int { return Double(value) }
    return nil
}

/// 读取所有 IOAccelerator 的 PerformanceStatistics 字典
func acceleratorStatistics() -> [[String: Any]] {
    var results: [[String: Any]] = []
    guard let matching = IOServiceMatching("IOAccelerator") else { return results }
    var iterator: io_iterator_t = 0
    guard IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator) == KERN_SUCCESS
    else { return results }
    defer { IOObjectRelease(iterator) }

    var service = IOIteratorNext(iterator)
    while service != 0 {
        var properties: Unmanaged<CFMutableDictionary>?
        if IORegistryEntryCreateCFProperties(service, &properties, kCFAllocatorDefault, 0) == KERN_SUCCESS,
           let dictionary = properties?.takeRetainedValue() as? [String: Any],
           let statistics = dictionary["PerformanceStatistics"] as? [String: Any] {
            results.append(statistics)
        }
        IOObjectRelease(service)
        service = IOIteratorNext(iterator)
    }
    return results
}

/// GPU 占用：多加速器取最大值（与 Windows GpuLoad 的 Maximum 语义一致）
func gpuLoad(_ statistics: [[String: Any]]) -> Double? {
    let values = statistics.compactMap { row -> Double? in
        numberValue(row["Device Utilization %"]) ?? numberValue(row["GPU Activity(%)"])
    }
    return values.max()
}

/// 显存占用：已用 / 已分配（对应 Windows 的 used/total 回退分支）
func vramLoad(_ statistics: [[String: Any]]) -> Double? {
    let values = statistics.compactMap { row -> Double? in
        if let direct = numberValue(row["GPU Memory"]) { return direct }
        guard let used = numberValue(row["In use system memory"]),
              let total = numberValue(row["Alloc system memory"]), total > 0 else { return nil }
        return used / total * 100
    }
    return values.max()
}

/* ---------- SMC 温度 / 功耗（Intel Mac 可用；Apple Silicon 无 AppleSMC 服务） ----------
 * 说明：Apple Silicon 的 SMC 不暴露 CPU/GPU 温度与整机功耗键，本函数会直接返回 nil，
 * 面板按「不可用」显示（与 Windows 端逐项缺失的处理一致）。
 * 以下键名沿用 Apple SMC 通用约定，未在 Apple Silicon 机器上验证。
 */
struct SMCKeyData {
    var key: UInt32 = 0
    var dataSize: UInt32 = 0
    var dataType: UInt32 = 0
    var dataAttributes: UInt8 = 0
    var result: UInt8 = 0
    var status: UInt8 = 0
    var data8: UInt8 = 0
    var data32: UInt32 = 0
    var bytes: (UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
                UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
                UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8,
                UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8) =
        (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
         0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
}

final class SMCReader {
    private var connection: io_connect_t = 0
    private(set) var available = false

    init() {
        guard let matching = IOServiceMatching("AppleSMC") else { return }
        let service = IOServiceGetMatchingService(kIOMainPortDefault, matching)
        guard service != 0 else { return }   // Apple Silicon：无此服务
        defer { IOObjectRelease(service) }
        guard IOServiceOpen(service, mach_task_self_, 0, &connection) == KERN_SUCCESS else { return }
        available = true
    }

    deinit {
        if available { IOServiceClose(connection) }
    }

    private func fourCharCode(_ text: String) -> UInt32 {
        var code: UInt32 = 0
        for scalar in text.unicodeScalars.prefix(4) {
            code = (code << 8) | (scalar.value & 0xFF)
        }
        return code
    }

    /// 读取一个 SMC 键，返回其浮点值
    func read(_ key: String) -> Double? {
        guard available else { return nil }
        var input = SMCKeyData()
        var output = SMCKeyData()
        input.key = fourCharCode(key)
        input.data8 = 9   // kSMCGetKeyInfo
        var outputSize = MemoryLayout<SMCKeyData>.stride
        guard IOConnectCallStructMethod(connection, 2, &input,
                                        MemoryLayout<SMCKeyData>.stride,
                                        &output, &outputSize) == KERN_SUCCESS else { return nil }
        let dataSize = output.dataSize
        let dataType = output.dataType

        var value = SMCKeyData()
        value.key = input.key
        value.dataSize = dataSize
        value.data8 = 5   // kSMCReadKey
        outputSize = MemoryLayout<SMCKeyData>.stride
        guard IOConnectCallStructMethod(connection, 2, &value,
                                        MemoryLayout<SMCKeyData>.stride,
                                        &output, &outputSize) == KERN_SUCCESS else { return nil }

        let bytes = withUnsafeBytes(of: output.bytes) { Array($0) }
        // "sp78"：定点数，前两字节为大端有符号值 / 256
        if dataType == fourCharCode("sp78"), bytes.count >= 2 {
            let raw = Int16(bitPattern: UInt16(bytes[0]) << 8 | UInt16(bytes[1]))
            return Double(raw) / 256.0
        }
        // "flt "：IEEE 单精度大端
        if dataType == fourCharCode("flt "), bytes.count >= 4 {
            let bits = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 |
                UInt32(bytes[2]) << 8 | UInt32(bytes[3])
            return Double(Float(bitPattern: bits))
        }
        // "fpe2"：定点数，前两字节为大端无符号值 / 4（部分功耗键）
        if dataType == fourCharCode("fpe2"), bytes.count >= 2 {
            let raw = UInt16(bytes[0]) << 8 | UInt16(bytes[1])
            return Double(raw) / 4.0
        }
        return nil
    }

    /// CPU 温度：按优先级尝试常见键（与 Windows Preferred(...) 的多候选语义一致）
    func cpuTemperature() -> Double? {
        for key in ["TC0P", "TC0D", "TC0E", "TC0F", "TC0H", "TCXC", "Tp09", "Tp0T"] {
            if let value = read(key), value > 0 { return value }
        }
        return nil
    }

    func gpuTemperature() -> Double? {
        for key in ["TG0P", "TG0D", "TG0H", "TG0T", "Tg0P"] {
            if let value = read(key), value > 0 { return value }
        }
        return nil
    }

    /// 整机功耗：PSTR 优先，退回 PCPT
    func systemPower() -> Double? {
        for key in ["PSTR", "PCPT", "PC0C"] {
            if let value = read(key), value > 0 { return value }
        }
        return nil
    }
}

/* ---------- 输出 ---------- */
func minuteKey(_ date: Date) -> String {
    let calendar = Calendar.current
    let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    return String(format: "%04d-%02d-%02dT%02d:%02d",
                  parts.year ?? 0, parts.month ?? 0, parts.day ?? 0,
                  parts.hour ?? 0, parts.minute ?? 0)
}

func jsonNumber(_ value: Double?) -> String {
    guard let value else { return "null" }
    return String(format: "%.1f", value)
}

func emit(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

/* ---------- 主循环 ---------- */
let smc = SMCReader()
var previousTicks = cpuTicks()

emit("{\"type\":\"hello\",\"version\":\"\(VERSION)\",\"intervalSeconds\":\(intervalSeconds),"
    + "\"smcAvailable\":\(smc.available ? "true" : "false")}")

while true {
    Thread.sleep(forTimeInterval: intervalSeconds)

    let currentTicks = cpuTicks()
    var cpu: Double?
    if let previousTicks, let currentTicks {
        cpu = cpuLoad(from: previousTicks, to: currentTicks)
    }
    previousTicks = currentTicks

    let statistics = acceleratorStatistics()
    let cpuTemperature = smc.cpuTemperature()
    let gpuTemperature = smc.gpuTemperature()

    // 温度优先取 SMC；不可用时尝试加速器统计中的温度键
    var gpuTemperatureFinal = gpuTemperature
    if gpuTemperatureFinal == nil {
        gpuTemperatureFinal = statistics.compactMap { numberValue($0["GPU Temperature"]) }.max()
    }
    var cpuTemperatureFinal = cpuTemperature
    if cpuTemperatureFinal == nil {
        cpuTemperatureFinal = statistics.compactMap { numberValue($0["CPU Temperature"]) }.max()
    }

    // 功耗：仅 Intel Mac 的 SMC 可读。Apple Silicon 的 powermetrics 必须 root，
    // 而 IOReport「Energy Model」中 CPU 侧为状态型通道（实测 6 核满载时仍取不到
    // 增量，只有 GPU Energy 有值），仅 GPU 一项不足以代表整机功耗，故此处保持 null，
    // 面板按「不可用」显示，不影响其余指标。
    let powerWatts = smc.systemPower()

    let sample = "{"
        + "\"t\":\"\(minuteKey(Date()))\","
        + "\"cpu\":\(jsonNumber(percent(cpu))),"
        + "\"gpu\":\(jsonNumber(percent(gpuLoad(statistics)))),"
        + "\"mem\":\(jsonNumber(percent(memoryLoad()))),"
        + "\"vram\":\(jsonNumber(percent(vramLoad(statistics)))),"
        + "\"cpuTemp\":\(jsonNumber(temperature(cpuTemperatureFinal))),"
        + "\"gpuTemp\":\(jsonNumber(temperature(gpuTemperatureFinal))),"
        + "\"power\":\(jsonNumber(watts(powerWatts))),"
        + "\"disk\":\(jsonNumber(percent(diskLoad())))"
        + "}"
    emit(sample)
}

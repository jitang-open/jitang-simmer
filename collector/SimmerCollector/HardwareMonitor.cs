using LibreHardwareMonitor.Hardware;

namespace SimmerCollector;

/// <summary>
/// LibreHardwareMonitor 适配层。传感器按类型、硬件类别和名称优先级归一化，
/// 不把单一厂商的名称或某个传感器缺失当作全局失败。
/// </summary>
internal sealed class HardwareMonitor : IDisposable
{
    private readonly object _lock = new();
    private Computer? _computer;
    private bool _disposed;

    public HardwareMonitor()
    {
        try
        {
            _computer = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsMemoryEnabled = true,
                IsMotherboardEnabled = true,
                IsStorageEnabled = true,
                IsPsuEnabled = true,
                IsPowerMonitorEnabled = true,
            };
            _computer.Open();
            Log.Write("LibreHardwareMonitor 已初始化；部分温度/功耗传感器可能需要管理员权限");
        }
        catch (Exception ex)
        {
            Log.Write("LibreHardwareMonitor 初始化失败，软件时长与 Token 采集继续运行: " + ex.Message);
            try { _computer?.Close(); } catch { }
            _computer = null;
        }
    }

    public HardwareSample? Capture()
    {
        lock (_lock)
        {
            if (_disposed || _computer == null) return null;
            try
            {
                _computer.Accept(new UpdateVisitor());
                var hardware = Walk(_computer.Hardware).ToList();

                double? cpu = CpuLoad(hardware);
                double? gpu = GpuLoad(hardware);
                double? memory = MemoryLoad(hardware);
                double? vram = VramLoad(hardware);
                double? cpuTemp = CpuTemperature(hardware);
                double? gpuTemp = GpuTemperature(hardware);
                double? power = Power(hardware);
                double? disk = DiskLoad(hardware);

                var row = new HardwareSample(
                    DateTime.Now.ToString("yyyy-MM-ddTHH:mm"),
                    Percent(cpu), Percent(gpu), Percent(memory), Percent(vram),
                    Temperature(cpuTemp), Temperature(gpuTemp), Watts(power), Percent(disk));
                return row.HasValue ? row : null;
            }
            catch (Exception ex)
            {
                Log.Write("硬件采样失败，本轮跳过: " + ex.Message);
                return null;
            }
        }
    }

    private static IEnumerable<IHardware> Walk(IEnumerable<IHardware> roots)
    {
        foreach (var hardware in roots)
        {
            yield return hardware;
            foreach (var child in Walk(hardware.SubHardware)) yield return child;
        }
    }

    private static bool IsGpu(IHardware hardware) => hardware.HardwareType is
        HardwareType.GpuNvidia or HardwareType.GpuAmd or HardwareType.GpuIntel;

    private static List<ISensor> Sensors(
        IEnumerable<IHardware> hardware, Func<IHardware, bool> hardwareFilter, SensorType type) =>
        hardware.Where(hardwareFilter)
            .SelectMany(row => row.Sensors)
            .Where(sensor => sensor.SensorType == type && sensor.Value is not null &&
                !float.IsNaN(sensor.Value.Value) && !float.IsInfinity(sensor.Value.Value))
            .ToList();

    private static double? Preferred(IEnumerable<ISensor> sensors, params string[] names)
    {
        var rows = sensors.ToList();
        foreach (string name in names)
        {
            var exact = rows.FirstOrDefault(sensor => sensor.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
            if (exact?.Value is float exactValue) return exactValue;
        }
        foreach (string name in names)
        {
            var contains = rows.FirstOrDefault(sensor => sensor.Name.Contains(name, StringComparison.OrdinalIgnoreCase));
            if (contains?.Value is float containsValue) return containsValue;
        }
        return null;
    }

    private static double? Average(IEnumerable<ISensor> sensors)
    {
        var values = sensors.Where(sensor => sensor.Value.HasValue).Select(sensor => (double)sensor.Value!.Value).ToList();
        return values.Count == 0 ? null : values.Average();
    }

    private static double? Maximum(IEnumerable<double?> values)
    {
        var present = values.Where(value => value.HasValue).Select(value => value!.Value).ToList();
        return present.Count == 0 ? null : present.Max();
    }

    private static double? CpuLoad(List<IHardware> hardware)
    {
        var sensors = Sensors(hardware, row => row.HardwareType == HardwareType.Cpu, SensorType.Load);
        return Preferred(sensors, "CPU Total", "Total CPU") ??
            Average(sensors.Where(sensor => sensor.Name.Contains("Core", StringComparison.OrdinalIgnoreCase)));
    }

    private static double? CpuTemperature(List<IHardware> hardware)
    {
        var sensors = Sensors(hardware, row => row.HardwareType == HardwareType.Cpu, SensorType.Temperature)
            .Where(sensor => sensor.Value > 0).ToList();
        return Preferred(sensors, "CPU Package", "Core (Tctl/Tdie)", "Package", "Core Average", "Core Max") ??
            Maximum(sensors.Select(sensor => (double?)sensor.Value));
    }

    private static double? GpuLoad(List<IHardware> hardware) => Maximum(
        hardware.Where(IsGpu).Select(row =>
        {
            var sensors = Sensors([row], _ => true, SensorType.Load);
            return Preferred(sensors, "GPU Core", "D3D 3D", "GPU Total") ?? Average(sensors);
        }));

    private static double? GpuTemperature(List<IHardware> hardware) => Maximum(
        hardware.Where(IsGpu).Select(row =>
        {
            var sensors = Sensors([row], _ => true, SensorType.Temperature)
                .Where(sensor => sensor.Value > 0).ToList();
            return Preferred(sensors, "GPU Core", "GPU Hot Spot", "GPU Memory") ??
                Maximum(sensors.Select(sensor => (double?)sensor.Value));
        }));

    private static double? MemoryLoad(List<IHardware> hardware)
    {
        var sensors = Sensors(hardware, row => row.HardwareType == HardwareType.Memory, SensorType.Load);
        return Preferred(sensors, "Memory", "Memory Used") ?? Average(sensors);
    }

    private static double? VramLoad(List<IHardware> hardware) => Maximum(
        hardware.Where(IsGpu).Select(row =>
        {
            var loads = Sensors([row], _ => true, SensorType.Load);
            double? direct = Preferred(loads, "GPU Memory", "D3D Dedicated Memory");
            if (direct.HasValue) return direct;

            var sizes = Sensors([row], _ => true, SensorType.SmallData);
            double? used = Preferred(sizes, "GPU Memory Used", "D3D Dedicated Memory Used");
            double? total = Preferred(sizes, "GPU Memory Total", "D3D Dedicated Memory Total");
            return used.HasValue && total > 0 ? used.Value / total.Value * 100 : null;
        }));

    private static double? DiskLoad(List<IHardware> hardware) => Maximum(
        hardware.Where(row => row.HardwareType == HardwareType.Storage).Select(row =>
        {
            var sensors = Sensors([row], _ => true, SensorType.Load);
            return Preferred(sensors, "Used Space", "Disk Used") ?? Maximum(sensors.Select(sensor => (double?)sensor.Value));
        }));

    private static double? Power(List<IHardware> hardware)
    {
        var direct = Sensors(hardware,
            row => row.HardwareType is HardwareType.Psu or HardwareType.PowerMonitor,
            SensorType.Power);
        double? system = Preferred(direct, "System Total", "Total", "Input", "Power");
        if (system.HasValue) return system;

        double sum = 0;
        bool found = false;
        foreach (var row in hardware.Where(row => row.HardwareType == HardwareType.Cpu || IsGpu(row)))
        {
            var sensors = Sensors([row], _ => true, SensorType.Power);
            double? value = row.HardwareType == HardwareType.Cpu
                ? Preferred(sensors, "CPU Package", "Package")
                : Preferred(sensors, "GPU Package", "GPU Board Power", "GPU Total");
            if (!value.HasValue) continue;
            sum += value.Value;
            found = true;
        }
        return found ? sum : null;
    }

    private static double? Normalize(double? value, double min, double max)
    {
        if (!value.HasValue || double.IsNaN(value.Value) || double.IsInfinity(value.Value) ||
            value.Value < min || value.Value > max) return null;
        return Math.Round(value.Value, 1);
    }

    private static double? Percent(double? value) => Normalize(value, 0, 100);
    // 运行中的 CPU/GPU 不可能稳定为 0°C；部分驱动会用 0 表示“无读数”。
    private static double? Temperature(double? value) => Normalize(value, 1, 150);
    private static double? Watts(double? value) => Normalize(value, 0, 5000);

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            try { _computer?.Close(); } catch { }
            _computer = null;
        }
    }

    private sealed class UpdateVisitor : IVisitor
    {
        public void VisitComputer(IComputer computer) => computer.Traverse(this);
        public void VisitHardware(IHardware hardware)
        {
            hardware.Update();
            foreach (var subHardware in hardware.SubHardware) subHardware.Accept(this);
        }
        public void VisitSensor(ISensor sensor) { }
        public void VisitParameter(IParameter parameter) { }
    }
}

using System.Text.Json.Serialization;

namespace SimmerCollector;

/// <summary>
/// 一分钟一条硬件快照。字段允许为空：某类传感器不可用时不得阻塞其余指标与软件时长采集。
/// </summary>
public sealed record HardwareSample(
    [property: JsonPropertyName("t")] string T,
    [property: JsonPropertyName("cpu")] double? Cpu,
    [property: JsonPropertyName("gpu")] double? Gpu,
    [property: JsonPropertyName("mem")] double? Memory,
    [property: JsonPropertyName("vram")] double? Vram,
    [property: JsonPropertyName("cpuTemp")] double? CpuTemperature,
    [property: JsonPropertyName("gpuTemp")] double? GpuTemperature,
    [property: JsonPropertyName("power")] double? Power,
    [property: JsonPropertyName("disk")] double? Disk)
{
    [JsonIgnore]
    public bool HasValue => Cpu.HasValue || Gpu.HasValue || Memory.HasValue || Vram.HasValue ||
        CpuTemperature.HasValue || GpuTemperature.HasValue || Power.HasValue || Disk.HasValue;
}

using System.Text.Json;

namespace SimmerCollector;

/// <summary>
/// 采集端配置：默认持久化于 %APPDATA%\SimmerCollector；安装目录存在 portable.flag 时，
/// 改用 EXE 同目录下的 data，便于整体安装、备份和迁移（CAP-05 / CAP-07）。
/// </summary>
internal class Config
{
    public string DeviceId { get; set; } = Guid.NewGuid().ToString("N").Substring(0, 12);
    public string DeviceName { get; set; } = Environment.MachineName;
    public string ServerUrl { get; set; } = "http://localhost:8788";
    public string Token { get; set; } = "";
    /// <summary>键鼠空闲阈值（分钟），超过则不计入使用时长（CAP-03）</summary>
    public int IdleThresholdMinutes { get; set; } = 5;
    /// <summary>上报间隔（分钟）</summary>
    public int UploadIntervalMinutes { get; set; } = 5;
    /// <summary>登录当前 Windows 用户后自动启动采集器（CAP-04）。</summary>
    public bool StartWithWindows { get; set; }
    /// <summary>是否启用 LibreHardwareMonitor 硬件指标采集（CAP-06）。</summary>
    public bool EnableHardwareMonitoring { get; set; } = true;
    /// <summary>是否启用本地 AI Token 来源扫描。</summary>
    public bool EnableTokenStatistics { get; set; } = true;
    /// <summary>Token 兜底扫描间隔；文件变化仍会在约 5 秒后触发。</summary>
    public int TokenScanIntervalMinutes { get; set; } = 15;
    /// <summary>可选手动数据根；留空时按环境变量和用户默认目录自动发现。</summary>
    public string CodexHome { get; set; } = "";
    public string ZCodeHome { get; set; } = "";
    public string DshHome { get; set; } = "";
    public string WorkBuddyHome { get; set; } = "";

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    public static string Dir { get; } = ResolveDataDirectory();

    private static string ResolveDataDirectory()
    {
        string? configured = Environment.GetEnvironmentVariable("SIMMER_DATA_DIR");
        if (!string.IsNullOrWhiteSpace(configured))
            return Path.GetFullPath(Environment.ExpandEnvironmentVariables(configured));

        string installRoot = AppContext.BaseDirectory;
        if (File.Exists(Path.Combine(installRoot, "portable.flag")))
            return Path.Combine(installRoot, "data");

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SimmerCollector");
    }

    private static string PathFor(string file) => System.IO.Path.Combine(Dir, file);

    public static Config Load()
    {
        Directory.CreateDirectory(Dir);
        string file = PathFor("config.json");
        if (File.Exists(file))
        {
            var cfg = JsonSerializer.Deserialize<Config>(File.ReadAllText(file));
            if (cfg != null) return cfg;
        }
        var fresh = new Config();
        fresh.Save();
        return fresh;
    }

    public void Save()
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(PathFor("config.json"), JsonSerializer.Serialize(this, JsonOpts));
    }
}

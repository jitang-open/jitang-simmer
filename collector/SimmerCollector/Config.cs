using System.Text.Json;

namespace SimmerCollector;

/// <summary>采集端配置：持久化于 %APPDATA%\SimmerCollector\config.json（CAP-05 / CAP-07）</summary>
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

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = true };

    public static string Dir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "SimmerCollector");

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

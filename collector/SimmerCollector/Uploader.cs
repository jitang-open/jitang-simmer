using System.Text;
using System.Text.Json;

namespace SimmerCollector;

/// <summary>批量上报（CAP-05）：POST {deviceId, deviceName, minutes} → 中心后端 /api/ingest</summary>
internal class Uploader
{
    private static readonly string CollectorVersion =
        typeof(Uploader).Assembly.GetName().Version?.ToString(3) ?? "";
    // 本地后端直连：禁用系统代理（部分网络环境的全局代理会劫持 localhost 请求）
    private static readonly HttpClient Http = new(new HttpClientHandler
    {
        UseProxy = false,
    })
    { Timeout = TimeSpan.FromSeconds(15) };

    private class Payload
    {
        public string deviceId { get; set; } = "";
        public string deviceName { get; set; } = "";
        public int syncIntervalMinutes { get; set; }
        public string collectorVersion { get; set; } = "";
        public List<MinuteRecord> minutes { get; set; } = new();
    }

    private class TokenPayload
    {
        public string deviceId { get; set; } = "";
        public string deviceName { get; set; } = "";
        public int syncIntervalMinutes { get; set; }
        public string collectorVersion { get; set; } = "";
        public List<TokenEvent> events { get; set; } = new();
        public List<TokenSourceStatus> statuses { get; set; } = new();
    }

    private class HardwarePayload
    {
        public string deviceId { get; set; } = "";
        public string deviceName { get; set; } = "";
        public int syncIntervalMinutes { get; set; }
        public string collectorVersion { get; set; } = "";
        public List<HardwareSample> samples { get; set; } = new();
    }

    private class HeartbeatPayload
    {
        public string deviceId { get; set; } = "";
        public string deviceName { get; set; } = "";
        public int syncIntervalMinutes { get; set; }
        public string collectorVersion { get; set; } = "";
    }

    /// <summary>上报一批记录；成功返回 true（调用方负责从本地队列移除）</summary>
    public static async Task<bool> FlushAsync(Config cfg, List<MinuteRecord> records)
    {
        if (records.Count == 0) return true;
        try
        {
            var json = JsonSerializer.Serialize(new Payload
            {
                deviceId = cfg.DeviceId,
                deviceName = cfg.DeviceName,
                syncIntervalMinutes = cfg.UploadIntervalMinutes,
                collectorVersion = CollectorVersion,
                minutes = records,
            });
            var req = new HttpRequestMessage(HttpMethod.Post, cfg.ServerUrl.TrimEnd('/') + "/api/ingest")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Token);
            using var resp = await Http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                string body = await resp.Content.ReadAsStringAsync();
                Log.Write($"上报失败 HTTP {(int)resp.StatusCode}: {(body.Length > 200 ? body.Substring(0, 200) : body)}");
                return false;
            }
            Log.Write($"上报成功 {records.Count} 条 → {cfg.DeviceId}");
            return true;
        }
        catch (Exception ex)
        {
            Log.Write("上报异常: " + ex.Message);      // 断网 / 服务端未启动：队列保留，下次重试
            return false;
        }
    }

    /// <summary>上报请求级 Token 数字事件与来源状态；不包含本地路径和对话内容。</summary>
    public static async Task<bool> FlushTokenAsync(
        Config cfg, List<TokenEvent> events, List<TokenSourceStatus> statuses)
    {
        if (events.Count == 0 && statuses.Count == 0) return true;
        try
        {
            var json = JsonSerializer.Serialize(new TokenPayload
            {
                deviceId = cfg.DeviceId,
                deviceName = cfg.DeviceName,
                syncIntervalMinutes = cfg.UploadIntervalMinutes,
                collectorVersion = CollectorVersion,
                events = events,
                statuses = statuses,
            });
            var req = new HttpRequestMessage(HttpMethod.Post, cfg.ServerUrl.TrimEnd('/') + "/api/ai-token-events")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Token);
            using var resp = await Http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                string body = await resp.Content.ReadAsStringAsync();
                Log.Write($"Token 上报失败 HTTP {(int)resp.StatusCode}: {(body.Length > 200 ? body[..200] : body)}");
                return false;
            }
            Log.Write($"Token 上报成功 {events.Count} 条，来源状态 {statuses.Count} 条");
            return true;
        }
        catch (Exception ex)
        {
            Log.Write("Token 上报异常: " + ex.Message);
            return false;
        }
    }

    /// <summary>上报一分钟粒度硬件样本；字段缺失使用 null，不上传驱动或硬件标识。</summary>
    public static async Task<bool> FlushHardwareAsync(Config cfg, List<HardwareSample> samples)
    {
        if (samples.Count == 0) return true;
        try
        {
            var json = JsonSerializer.Serialize(new HardwarePayload
            {
                deviceId = cfg.DeviceId,
                deviceName = cfg.DeviceName,
                syncIntervalMinutes = cfg.UploadIntervalMinutes,
                collectorVersion = CollectorVersion,
                samples = samples,
            });
            var req = new HttpRequestMessage(HttpMethod.Post, cfg.ServerUrl.TrimEnd('/') + "/api/hardware-samples")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Token);
            using var resp = await Http.SendAsync(req);
            if (!resp.IsSuccessStatusCode)
            {
                string body = await resp.Content.ReadAsStringAsync();
                Log.Write($"硬件上报失败 HTTP {(int)resp.StatusCode}: {(body.Length > 200 ? body[..200] : body)}");
                return false;
            }
            Log.Write($"硬件上报成功 {samples.Count} 条");
            return true;
        }
        catch (Exception ex)
        {
            Log.Write("硬件上报异常: " + ex.Message);
            return false;
        }
    }

    /// <summary>队列为空时仍定期报告在线状态，使中心服务器能区分空闲与离线。</summary>
    public static async Task<bool> HeartbeatAsync(Config cfg)
    {
        try
        {
            var json = JsonSerializer.Serialize(new HeartbeatPayload
            {
                deviceId = cfg.DeviceId,
                deviceName = cfg.DeviceName,
                syncIntervalMinutes = cfg.UploadIntervalMinutes,
                collectorVersion = CollectorVersion,
            });
            var req = new HttpRequestMessage(HttpMethod.Post, cfg.ServerUrl.TrimEnd('/') + "/api/device-heartbeat")
            {
                Content = new StringContent(json, Encoding.UTF8, "application/json"),
            };
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.Token);
            using var resp = await Http.SendAsync(req);
            if (resp.IsSuccessStatusCode) return true;
            Log.Write($"设备心跳失败 HTTP {(int)resp.StatusCode}");
            return false;
        }
        catch (Exception ex)
        {
            Log.Write("设备心跳异常: " + ex.Message);
            return false;
        }
    }
}

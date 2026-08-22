using System.Text;
using System.Text.Json;

namespace SimmerCollector;

/// <summary>批量上报（CAP-05）：POST {deviceId, deviceName, minutes} → 中心后端 /api/ingest</summary>
internal class Uploader
{
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
        public List<MinuteRecord> minutes { get; set; } = new();
    }

    private class TokenPayload
    {
        public string deviceId { get; set; } = "";
        public string deviceName { get; set; } = "";
        public List<TokenEvent> events { get; set; } = new();
        public List<TokenSourceStatus> statuses { get; set; } = new();
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
}

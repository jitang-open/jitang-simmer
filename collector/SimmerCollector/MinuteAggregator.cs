using System.Text.Json.Serialization;

namespace SimmerCollector;

/// <summary>一分钟一条的聚合结果：t = 'yyyy-MM-ddTHH:mm'（本地时间），app = 该分钟主导前台进程。
/// JSON 字段名固定小写（t / app），与后端上报协议一致。</summary>
public record MinuteRecord(
    [property: JsonPropertyName("t")] string T,
    [property: JsonPropertyName("app")] string App);

/// <summary>
/// 按分钟聚合（CAP-01）：每 2 秒接收一次采样（含空闲状态），
/// 每分钟结算一次——非空闲采样过半且存在主导进程时，产出一条 MinuteRecord。
/// </summary>
internal class MinuteAggregator
{
    private readonly object _lock = new();
    private string _currentKey = "";
    private int _idleSamples;
    private readonly Dictionary<string, int> _appSamples = new();

    /// <summary>每分钟结算时触发（在采样线程调用）</summary>
    public event Action<MinuteRecord>? MinuteCompleted;

    private static string KeyOf(DateTime t) => t.ToString("yyyy-MM-ddTHH:mm");

    /// <summary>记录一次采样。idle=true（键鼠空闲/锁屏）的采样不归属任何软件。</summary>
    public void AddSample(bool idle, string? exe)
    {
        MinuteRecord? completed = null;
        lock (_lock)
        {
            var now = DateTime.Now;
            string key = KeyOf(now);
            if (key != _currentKey)
            {
                completed = Settle(_currentKey, key);
                _currentKey = key;
                _idleSamples = 0;
                _appSamples.Clear();
            }
            if (idle) { _idleSamples++; return; }
            if (!string.IsNullOrEmpty(exe))
            {
                _appSamples[exe] = _appSamples.GetValueOrDefault(exe) + 1;
            }
        }
        if (completed != null) MinuteCompleted?.Invoke(completed);
    }

    /// <summary>结算上一分钟：非空闲采样未过半、或无任何进程采样时丢弃该分钟</summary>
    private MinuteRecord? Settle(string minuteKey, string nextKey)
    {
        if (minuteKey == "" || _appSamples.Count == 0) return null;
        int total = _idleSamples + _appSamples.Values.Sum();
        if (total == 0) return null;
        if (_idleSamples * 2 >= total) return null;   // 过半时间空闲 → 不计

        var top = _appSamples.OrderByDescending(kv => kv.Value).First();
        return new MinuteRecord(minuteKey, top.Key);
    }

    /// <summary>退出前结算当前未完成的分钟（可选，尽力而为）</summary>
    public MinuteRecord? FlushCurrent()
    {
        lock (_lock)
        {
            var r = Settle(_currentKey, "~~flush~~");
            _currentKey = "";
            _appSamples.Clear();
            _idleSamples = 0;
            return r;
        }
    }
}

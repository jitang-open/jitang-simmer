using System.Text.Json;

namespace SimmerCollector;

/// <summary>
/// Token 离线队列。只持久化归一化数字事件和来源状态，不写入原始日志、会话 ID 或本地路径。
/// </summary>
internal sealed class TokenLocalStore
{
    private sealed class StoreData
    {
        public List<TokenEvent> Events { get; set; } = new();
        public List<TokenSourceStatus> Statuses { get; set; } = new();
        public List<string> AcknowledgedIds { get; set; } = new();
        public DateTimeOffset? LastFullScan { get; set; }
    }

    private readonly object _lock = new();
    private readonly string _file = Path.Combine(Config.Dir, "token-queue.json");
    private readonly Dictionary<string, TokenEvent> _events = new();
    private readonly Dictionary<string, TokenSourceStatus> _statuses = new();
    private readonly HashSet<string> _acknowledged = new(StringComparer.Ordinal);
    private DateTimeOffset? _lastFullScan;
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

    public int Count { get { lock (_lock) return _events.Count; } }
    public DateTimeOffset? LastFullScan { get { lock (_lock) return _lastFullScan; } }
    public bool HasStatus(string source) { lock (_lock) return _statuses.ContainsKey(source); }

    public TokenLocalStore()
    {
        Directory.CreateDirectory(Config.Dir);
        Load();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var data = JsonSerializer.Deserialize<StoreData>(File.ReadAllText(_file), JsonOpts);
            if (data == null) return;
            foreach (string key in data.AcknowledgedIds.Where(key => !string.IsNullOrWhiteSpace(key)))
                _acknowledged.Add(key);
            foreach (var row in data.Events.Where(row => row.IsValid() && !_acknowledged.Contains(row.QueueKey)))
                _events[row.QueueKey] = row;
            foreach (var row in data.Statuses.Where(row => TokenProtocol.Sources.Contains(row.Source)))
                _statuses[row.Source] = row;
            _lastFullScan = data.LastFullScan;
        }
        catch (Exception ex)
        {
            Log.Write("Token 队列读取失败，保留文件并从空队列继续: " + ex.Message);
        }
    }

    public void Merge(IEnumerable<TokenEvent> events, IEnumerable<TokenSourceStatus> statuses, bool fullScan)
    {
        lock (_lock)
        {
            foreach (var row in events.Where(row => row.IsValid() && !_acknowledged.Contains(row.QueueKey)))
                _events[row.QueueKey] = row;
            foreach (var row in statuses) _statuses[row.Source] = row;
            if (fullScan) _lastFullScan = DateTimeOffset.UtcNow;
            Persist();
        }
    }

    public List<TokenEvent> Peek(int max)
    {
        lock (_lock) return _events.Values.OrderBy(row => row.OccurredAt).Take(max).ToList();
    }

    public List<TokenSourceStatus> Statuses()
    {
        lock (_lock) return _statuses.Values.OrderBy(row => row.Source).ToList();
    }

    public void Dequeue(IEnumerable<TokenEvent> sent)
    {
        lock (_lock)
        {
            foreach (var row in sent)
            {
                _events.Remove(row.QueueKey);
                _acknowledged.Add(row.QueueKey);
            }
            Persist();
        }
    }

    private void Persist()
    {
        var data = new StoreData
        {
            Events = _events.Values.ToList(),
            Statuses = _statuses.Values.ToList(),
            AcknowledgedIds = _acknowledged.OrderBy(key => key, StringComparer.Ordinal).ToList(),
            LastFullScan = _lastFullScan,
        };
        string temp = _file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(data, JsonOpts));
        if (File.Exists(_file)) File.Replace(temp, _file, null);
        else File.Move(temp, _file);
    }
}

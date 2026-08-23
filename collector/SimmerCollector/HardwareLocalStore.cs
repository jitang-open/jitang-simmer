using System.Text.Json;

namespace SimmerCollector;

/// <summary>硬件样本离线队列；同一分钟的新快照覆盖旧快照，断网后继续保留。</summary>
internal sealed class HardwareLocalStore
{
    private readonly object _lock = new();
    private readonly string _file = Path.Combine(Config.Dir, "hardware-queue.json");
    private readonly Dictionary<string, HardwareSample> _rows = new(StringComparer.Ordinal);
    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

    public int Count { get { lock (_lock) return _rows.Count; } }

    public HardwareLocalStore()
    {
        Directory.CreateDirectory(Config.Dir);
        try
        {
            if (!File.Exists(_file)) return;
            var rows = JsonSerializer.Deserialize<List<HardwareSample>>(File.ReadAllText(_file), JsonOpts) ?? [];
            foreach (var row in rows.Where(row => row.HasValue && !string.IsNullOrWhiteSpace(row.T)))
                _rows[row.T] = row;
        }
        catch (Exception ex)
        {
            Log.Write("硬件队列读取失败，保留原文件并从空队列继续: " + ex.Message);
        }
    }

    public void Upsert(HardwareSample row)
    {
        if (!row.HasValue || string.IsNullOrWhiteSpace(row.T)) return;
        lock (_lock)
        {
            _rows[row.T] = row;
            Persist();
        }
    }

    public List<HardwareSample> Peek(int max)
    {
        lock (_lock) return _rows.Values.OrderBy(row => row.T, StringComparer.Ordinal).Take(max).ToList();
    }

    public void Dequeue(IEnumerable<HardwareSample> sent)
    {
        lock (_lock)
        {
            foreach (var row in sent)
            {
                // 上报期间若同一分钟被新采样覆盖，不删除更新后的值。
                if (_rows.TryGetValue(row.T, out var current) && current == row) _rows.Remove(row.T);
            }
            Persist();
        }
    }

    private void Persist()
    {
        string temp = _file + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(_rows.Values.OrderBy(row => row.T), JsonOpts));
        if (File.Exists(_file)) File.Replace(temp, _file, null);
        else File.Move(temp, _file);
    }
}

using System.Text.Json;

namespace SimmerCollector;

/// <summary>
/// 待上报队列的本地持久化（CAP-05）：JSON 文件存储于 %APPDATA%\SimmerCollector\queue.json，
/// 断网 / 服务端不可达时数据不丢，联网后重试。
/// </summary>
internal class LocalStore
{
    private readonly object _lock = new();
    private readonly string _file;
    private List<MinuteRecord> _queue;

    private static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

    public int Count { get { lock (_lock) return _queue.Count; } }

    public LocalStore()
    {
        Directory.CreateDirectory(Config.Dir);
        _file = Path.Combine(Config.Dir, "queue.json");
        _queue = Load();
    }

    private List<MinuteRecord> Load()
    {
        try
        {
            if (File.Exists(_file))
                return JsonSerializer.Deserialize<List<MinuteRecord>>(File.ReadAllText(_file)) ?? new();
        }
        catch { /* 队列文件损坏时重新开始，不影响主流程 */ }
        return new List<MinuteRecord>();
    }

    public void Enqueue(MinuteRecord record)
    {
        lock (_lock)
        {
            _queue.Add(record);
            Persist();
        }
    }

    /// <summary>取出至多 max 条待上报记录（不移除，上报成功后再删）</summary>
    public List<MinuteRecord> Peek(int max)
    {
        lock (_lock) return _queue.Take(max).ToList();
    }

    /// <summary>上报成功后移除队首 count 条</summary>
    public void Dequeue(int count)
    {
        lock (_lock)
        {
            if (count >= _queue.Count) _queue.Clear();
            else _queue.RemoveRange(0, count);
            Persist();
        }
    }

    /// <summary>原子写：先写临时文件再替换，避免断电损坏</summary>
    private void Persist()
    {
        string tmp = _file + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(_queue, JsonOpts));
        if (File.Exists(_file)) File.Replace(tmp, _file, null);
        else File.Move(tmp, _file);
    }
}

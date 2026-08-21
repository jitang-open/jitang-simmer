namespace SimmerCollector;

/// <summary>轻量运行日志：%APPDATA%\SimmerCollector\log.txt（上报成败 / 异常摘要）</summary>
internal static class Log
{
    private static readonly string File = Path.Combine(Config.Dir, "log.txt");
    private static readonly object _lock = new();

    public static void Write(string msg)
    {
        try
        {
            lock (_lock) System.IO.File.AppendAllText(File, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} {msg}\n");
        }
        catch { /* 日志失败不影响主流程 */ }
    }
}

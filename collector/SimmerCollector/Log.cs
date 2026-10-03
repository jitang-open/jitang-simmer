namespace SimmerCollector;

/// <summary>
/// 轻量运行日志：logs\&lt;yyyy-MM&gt;\log-&lt;yyyy-MM-dd&gt;.txt（上报成败 / 异常摘要）。
/// 按天轮转，以凌晨 4 点为一天的分界（4 点前算前一天）；按月分文件夹；历史日志永不删除。
/// </summary>
internal static class Log
{
    private static readonly object _lock = new();
    private static string? _ensuredDirectory;
    private static bool _legacyMigrated;

    public static void Write(string msg)
    {
        try
        {
            lock (_lock)
            {
                MigrateLegacyFile();
                var now = DateTime.Now;
                // 4 点前属于前一个日志日：整体前移 4 小时再取日期
                var day = now.AddHours(-4).Date;
                string directory = Path.Combine(Config.Dir, "logs", day.ToString("yyyy-MM"));
                if (_ensuredDirectory != directory)
                {
                    Directory.CreateDirectory(directory);
                    _ensuredDirectory = directory;
                }
                System.IO.File.AppendAllText(
                    Path.Combine(directory, "log-" + day.ToString("yyyy-MM-dd") + ".txt"),
                    $"{now:yyyy-MM-dd HH:mm:ss} {msg}\n");
            }
        }
        catch { /* 日志失败不影响主流程 */ }
    }

    /// <summary>旧版单文件 log.txt 只移动到 logs\archive\ 归档，内容一字不丢。</summary>
    private static void MigrateLegacyFile()
    {
        if (_legacyMigrated) return;
        _legacyMigrated = true;
        try
        {
            string legacy = Path.Combine(Config.Dir, "log.txt");
            if (!System.IO.File.Exists(legacy)) return;
            string archiveDirectory = Path.Combine(Config.Dir, "logs", "archive");
            Directory.CreateDirectory(archiveDirectory);
            string target = Path.Combine(archiveDirectory, "log-legacy.txt");
            if (System.IO.File.Exists(target))
                target = Path.Combine(archiveDirectory, "log-legacy-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + ".txt");
            System.IO.File.Move(legacy, target);
        }
        catch { /* 迁移失败不影响写新日志 */ }
    }
}
